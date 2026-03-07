"""
HealthBench Hard evaluation script.

Reads the HealthBench Hard JSONL file, sends each prompt through our agent
pipeline, then uses Gemini to grade the response against each rubric criterion.

Usage:
    uv run python eval_healthbench.py --limit 5
    uv run python eval_healthbench.py --limit 20
"""

import argparse
import json
import logging
import os
import sys
import time

from dotenv import load_dotenv

load_dotenv()

from agent import AgentPipeline
from evidence_retriever import EvidenceRetriever
from llm_client import GeminiClient
from logger import setup_logging

setup_logging()
logger = logging.getLogger(__name__)

GRADING_PROMPT = """You are a medical answer grader. You will be given:
1. A patient question.
2. A model's answer to that question.
3. A single grading criterion.

Decide whether the criterion is MET or NOT MET by the answer.

Patient question:
{question}

Model answer:
{answer}

Grading criterion:
{criterion}

Points if met: {points}

Respond with EXACTLY one JSON object (no markdown fences):
{{"met": true or false, "reasoning": "one sentence explanation"}}
"""


def load_benchmark(path: str, limit: int | None = None) -> list[dict]:
    """Load HealthBench JSONL file."""
    examples = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                examples.append(json.loads(line))
                if limit and len(examples) >= limit:
                    break
    return examples


def get_question_text(prompt: list[dict]) -> str:
    """Extract the user question from the prompt messages."""
    parts = []
    for msg in prompt:
        parts.append(msg["content"])
    return parts[-1]  # last user message


def get_conversation(prompt: list[dict]) -> list[str]:
    """Convert HealthBench prompt format to our conversation format.

    HealthBench uses {"role": "user", "content": "..."} messages.
    Our pipeline expects a flat list of alternating user/AI strings.
    """
    messages = []
    for msg in prompt:
        messages.append(msg["content"])
    return messages


def grade_rubric(gemini: GeminiClient, question: str, answer: str, rubric: dict) -> dict:
    """Grade a single rubric criterion using Gemini."""
    prompt = GRADING_PROMPT.format(
        question=question,
        answer=answer,
        criterion=rubric["criterion"],
        points=rubric["points"],
    )
    try:
        raw = gemini.generate(prompt)
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            first_nl = cleaned.index("\n")
            cleaned = cleaned[first_nl + 1:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
        result = json.loads(cleaned)
        return {
            "criterion": rubric["criterion"],
            "points": rubric["points"],
            "met": result.get("met", False),
            "earned": rubric["points"] if result.get("met", False) else 0,
            "reasoning": result.get("reasoning", ""),
        }
    except Exception as e:
        logger.exception("Grading failed for criterion: %s", rubric["criterion"])
        # For negative rubrics, assume NOT met (no penalty) on failure
        # For positive rubrics, assume NOT met (no credit) on failure
        return {
            "criterion": rubric["criterion"],
            "points": rubric["points"],
            "met": False,
            "earned": 0,
            "reasoning": f"Grading error: {e}",
        }


def evaluate_example(
    pipeline: AgentPipeline,
    gemini: GeminiClient,
    example: dict,
    example_idx: int,
) -> dict:
    """Run pipeline on one HealthBench example and grade it."""
    prompt = example["prompt"]
    rubrics = example["rubrics"]
    question = get_question_text(prompt)
    conversation = get_conversation(prompt)
    conversation_id = example.get("prompt_id", f"healthbench-{example_idx}")

    print(f"\n{'='*60}")
    print(f"Example {example_idx + 1}: {question[:100]}...")
    print(f"{'='*60}")

    # Run our agent pipeline
    start = time.time()
    result = pipeline.run(
        conversation=conversation,
        conversation_id=conversation_id,
    )
    elapsed = time.time() - start

    # If pipeline returned follow-up questions, we need to handle that.
    # For benchmark purposes, concatenate follow-ups as the "answer".
    if result["type"] == "follow_up":
        answer = "I need more information. " + " ".join(result.get("follow_up_questions", []))
    else:
        answer = result.get("answer", "")

    print(f"  Pipeline took {elapsed:.1f}s")
    print(f"  Answer length: {len(answer)} chars")
    print(f"  Articles cited: {len(result.get('articles', []))}")
    print(f"  Tools used: {[t.get('tool', '') for t in result.get('tool_results', [])]}")

    # Grade each rubric
    max_possible = sum(r["points"] for r in rubrics if r["points"] > 0)
    graded = []
    for rubric in rubrics:
        g = grade_rubric(gemini, question, answer, rubric)
        graded.append(g)

    earned = sum(g["earned"] for g in graded)
    score_pct = (earned / max_possible * 100) if max_possible > 0 else 0

    print(f"\n  Score: {earned}/{max_possible} ({score_pct:.1f}%)")
    for g in graded:
        status = "PASS" if g["met"] else "FAIL"
        print(f"    [{status}] ({g['points']:+d}pts) {g['criterion'][:80]}")

    return {
        "example_idx": example_idx,
        "prompt_id": example.get("prompt_id", ""),
        "question": question[:200],
        "answer_length": len(answer),
        "articles_count": len(result.get("articles", [])),
        "tools_used": [t.get("tool", "") for t in result.get("tool_results", [])],
        "max_possible": max_possible,
        "earned": earned,
        "score_pct": score_pct,
        "graded_rubrics": graded,
        "elapsed_seconds": elapsed,
    }


def main():
    parser = argparse.ArgumentParser(description="Run HealthBench Hard evaluation")
    parser.add_argument("--limit", type=int, default=5, help="Number of examples to evaluate (default: 5)")
    parser.add_argument(
        "--file",
        type=str,
        default="healtbench/hard_2025-05-08-21-00-10.jsonl",
        help="Path to HealthBench JSONL file",
    )
    args = parser.parse_args()

    # Initialize components
    gemini = GeminiClient(
        api_key=os.environ["GEMINI_API_KEY"],
        model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    )
    evidence = EvidenceRetriever(api_key=os.environ["MEDISEARCH_API_KEY"])
    pipeline = AgentPipeline(gemini=gemini, evidence=evidence)

    # Load benchmark
    examples = load_benchmark(args.file, limit=args.limit)
    print(f"Loaded {len(examples)} HealthBench Hard examples")

    # Evaluate
    results = []
    for i, example in enumerate(examples):
        try:
            r = evaluate_example(pipeline, gemini, example, i)
            results.append(r)
        except Exception:
            logger.exception("Failed on example %d", i)
            print(f"  ERROR: Example {i + 1} failed, skipping")

    # Summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")

    if not results:
        print("No results to summarize.")
        return

    total_earned = sum(r["earned"] for r in results)
    total_possible = sum(r["max_possible"] for r in results)
    overall_pct = (total_earned / total_possible * 100) if total_possible > 0 else 0

    print(f"Examples evaluated: {len(results)}/{len(examples)}")
    print(f"Total score: {total_earned}/{total_possible}")
    print(f"Overall percentage: {overall_pct:.1f}%")
    print(f"Average per-example: {overall_pct:.1f}%")
    print(f"Average latency: {sum(r['elapsed_seconds'] for r in results)/len(results):.1f}s")
    print()

    for r in results:
        print(f"  Example {r['example_idx']+1}: {r['earned']}/{r['max_possible']} ({r['score_pct']:.1f}%) - {r['question'][:60]}...")

    # Save detailed results
    out_path = "healtbench/eval_results.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
                "examples_evaluated": len(results),
                "total_examples": len(examples),
                "total_earned": total_earned,
                "total_possible": total_possible,
                "overall_percentage": round(overall_pct, 2),
                "results": results,
            },
            f,
            indent=2,
        )
    print(f"\nDetailed results saved to {out_path}")


if __name__ == "__main__":
    main()
