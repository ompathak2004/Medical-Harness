# Third-party assets and services

The [MIT license](LICENSE) covers medical-harness application code and documentation. It does not replace the licenses of third-party data, models, fonts, or hosted APIs.

## BodyParts3D anatomy data

The regional GLB files and structure metadata in `static/assets/atlas/` are derived from [BodyParts3D](https://lifesciencedb.jp/bp3d/), © The Database Center for Life Science, under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The geometry has been simplified, regrouped into twelve focused scenes, dequantized, and recompressed. Attribution and a license link are also displayed in the anatomy viewer. [the atlas manifest](static/assets/atlas/manifest.json) records source revision and SHA-256 hashes; `scripts/build_atlas.mjs` reproduces the packs from the attributed source assets in Git history.Rebuild the atlas packs with `npm run build:anatomy`; the recorded source revision must be available in your local Git history.

The conversion pipeline uses assets from [anatomy-lab](https://github.com/MrH0v0/anatomy-lab), which is MIT licensed. See its repository for its license and source pipeline.

The previous full-body runtime assets and viewer are removed. The underlying licensed geometry is reused; these are reference structures, not generated clinical findings or patient-specific models.

## Bundled browser libraries

Three.js and its Meshopt decoder are bundled locally. Full MIT notices are retained for [Three.js](static/vendor-licenses/three-MIT.txt) and [Meshoptimizer](static/vendor-licenses/meshoptimizer-MIT.txt), with additional notices in generated bundles.

Selected [Lucide](https://lucide.dev/) icons use the ISC license. [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans) is self-hosted under the SIL Open Font License 1.1. Their full notices are in `static/vendor-licenses/`. The eye-pressure schematic is an original application asset. The active m monogram is an SVG adaptation of the approved OpenAI-generated concept preserved in `docs/brand/`; it is not an Adobe or stock asset. No generated squirrel image is included.

The educational guides use original application SVG schematics and paraphrase linked National Eye Institute, National Heart, Lung, and Blood Institute, National Institute of Diabetes and Digestive and Kidney Diseases, and National Institute of Arthritis and Musculoskeletal and Skin Diseases material. No source illustrations or clinical videos are copied. NIH does not endorse this application. The conceptual illustrations are not clinically validated simulations.

The bundled [`@vercel/analytics`](https://github.com/vercel/analytics) SDK uses the MIT license, preserved in `static/vendor-licenses/vercel-analytics.txt`. Vercel Web Analytics collects anonymous production page views through same-origin endpoints; it does not receive chat contents or clinical tool properties from this application.

## Growth reference data

`app/tools/data/growth_lms.json` bundles the LMS parameters of the [WHO Child Growth Standards 2006](https://www.cdc.gov/growthcharts/who-data-files.htm) (weight, length, and head circumference for age, 0 to 24 months) and the [CDC 2000 growth charts](https://www.cdc.gov/growthcharts/cdc-data-files.htm) (weight, stature, and BMI for age, 2 to 20 years). Both are published by the US Centers for Disease Control and Prevention; the files were retrieved on 2026-10-25 from `ftp.cdc.gov` and `cdc.gov`, and the manifest next to the data records their SHA-256 hashes and the retrieval date. The tables are unchanged apart from being combined into one JSON file. CDC and WHO do not endorse this application, and a percentile is not a diagnosis. `scripts/build_growth_tables.py` rebuilds the file from the same sources.

## External services

medical-harness calls Cerebras and MediSearch using your own API keys. Their services, returned content, and usage terms are independent of this repository's MIT license.

DailyMed and Europe PMC/PubMed reference records remain subject to their publishers' terms. The application retrieves a small number of links or abstract excerpts and preserves source links. No HealthBench dataset is bundled; the checked-in evaluation cases are synthetic project fixtures.
