import { escapeHtml } from './dom-utils.js';

const nih = 'https://www.nhlbi.nih.gov/health';
const digestive = 'https://www.niddk.nih.gov/health-information/digestive-diseases';
const urinary = 'https://www.niddk.nih.gov/health-information/urologic-diseases';
const joints = 'https://www.niams.nih.gov/health-topics';
const radiology = 'https://www.radiologyinfo.org/en/info/all-about-your-radiology-report';
const pressureTest = 'https://www.nhs.uk/tests-and-treatments/blood-pressure-test/';
const pressureCare = 'https://www.nhs.uk/conditions/high-blood-pressure/';
const ecgTest = 'https://medlineplus.gov/lab-tests/electrocardiogram/';
const state = (name, title, text, source, label) => ({ name, title, text, source, label });
const note = (title, text, source, label) => ({ title, text, source, label });
const label = (x, y, text, anchor = 'start') => `<text x="${x}" y="${y}" text-anchor="${anchor}">${escapeHtml(text)}</text>`;
const arrow = (path, head) => `<path class="guide-flow" d="${path}"/><path class="guide-arrow" d="${head}"/>`;
const frame = (title, description, drawing) => `<svg class="mechanism-diagram" viewBox="0 0 520 330" role="img" aria-labelledby="guide-diagram-title guide-diagram-desc"><title id="guide-diagram-title">${escapeHtml(title)}</title><desc id="guide-diagram-desc">${escapeHtml(description)}</desc>${drawing}</svg>`;

function airway(index) {
  const radius = index ? 45 : 77;
  return frame(index ? 'Narrowed airway in asthma' : 'An open airway', 'A cross-section compares the airway wall and the space for air. Swelling and tightening leave less space in the narrowed view.', `
    <circle class="guide-tissue" cx="230" cy="161" r="117"/>
    <circle class="guide-soft" cx="230" cy="161" r="96"/>
    <circle class="guide-space" cx="230" cy="161" r="${radius}"/>
    <path class="guide-leader" d="M340 116H375M230 ${161 - radius}V30H330"/>
    ${label(383, 113, 'Airway')}${label(383, 136, 'wall')}${label(334, 35, 'Space for air')}
    <circle class="guide-air" cx="230" cy="161" r="5"/>
    ${label(230, 312, index ? 'Swelling + tightening → less room for air' : 'Cross-section of a small airway', 'middle')}`);
}

function reflux(index) {
  return frame(index ? 'Stomach contents flow back upward' : 'The barrier at the stomach entrance', 'The esophagus leads down into the stomach. The reflux view shows an upward arrow through an incompletely closed lower esophageal sphincter.', `
    <path class="guide-tissue" d="M199 32V132C160 146 148 181 164 209C180 243 202 219 228 244C278 293 370 271 379 209C388 151 353 115 315 127C282 138 263 149 239 132V32Z"/>
    <path class="guide-soft" d="M194 206Q216 195 245 215T364 206Q349 269 282 262Q247 256 230 234Q210 213 194 225Z"/>
    <path class="guide-ring" d="M185 133H${index ? 202 : 217}M${index ? 236 : 225} 133H253"/>
    <path class="guide-leader" d="M240 59H333M184 133H75M352 225H413"/>
    ${label(340, 64, 'Esophagus')}${label(27, 114, 'Sphincter')}${label(409, 249, 'Stomach')}
    ${index ? arrow('M291 224Q225 214 220 178V78', 'm210 90 10-12 10 12') : arrow('M220 59V111', 'm210 99 10 12 10-12')}
    ${label(260, 312, index ? 'Reflux = contents moving upward' : 'The sphincter helps limit backflow', 'middle')}`);
}

function stone(index) {
  return frame(index ? 'A stone obstructing the ureter' : 'Urine travels toward the bladder', 'A simplified single kidney drains into a ureter leading down to the bladder. The blockage view places a stone in the ureter; its size is exaggerated for visibility.', `
    <path class="guide-tissue" d="M190 36C107 14 113 174 187 164C220 160 227 122 200 114C177 107 176 91 199 80C224 68 218 43 190 36Z"/>
    <path class="guide-channel" d="M196 96Q242 116 240 172V239"/>
    <path class="guide-space" d="M209 239Q240 226 270 239Q280 272 240 287Q202 272 209 239Z"/>
    <path class="guide-channel" d="M240 287V312"/>
    <path class="guide-leader" d="M143 67H46M248 189H370M270 256H370"/>
    ${label(34, 54, 'Kidney')}${label(376, 195, 'Ureter')}${label(376, 262, 'Bladder')}
    ${index ? '<path class="guide-obstruction" d="m238 142 16 14-5 18-20 1-8-17Z"/>' : ''}
    ${arrow(`M266 99V${index ? 135 : 219}`, index ? 'm256 123 10 12 10-12' : 'm256 207 10 12 10-12')}
    ${index ? `${label(330, 133, 'Stone')}<path class="guide-leader" d="M252 153L319 130"/>` : label(315, 130, 'Urine flow')}`);
}

function gallbladder(index) {
  return frame(index ? 'A gallstone blocks a bile duct' : 'Bile travels from the liver and gallbladder', 'The liver produces bile, the gallbladder stores it, and ducts carry it to the small intestine. A highlighted stone blocks the common bile duct in the second view.', `
    <path class="guide-tissue" d="M77 74Q110 39 207 51L354 90Q337 122 268 129Q204 158 93 145Z"/>
    <path class="guide-soft" d="M170 120Q124 141 147 189Q178 217 188 177L197 129Z"/>
    <path class="guide-channel" d="M269 105V244M193 143Q223 184 269 177"/>
    <path class="guide-tissue" d="M248 247Q297 223 327 252Q348 286 299 303H233V282H297Q322 273 309 263Q293 248 253 266Z"/>
    <path class="guide-leader" d="M354 91H390M147 179H43M278 191H366"/>
    ${label(393, 97, 'Liver')}${label(25, 209, 'Gallbladder')}${label(372, 193, 'Bile duct')}${label(352, 284, 'Small intestine')}
    ${arrow('M286 120V162', 'm276 150 10 12 10-12')}
    ${index ? '<path class="guide-obstruction" d="m267 204 15 8-4 18-17 2-7-13Z"/>' : arrow('M286 194V233', 'm276 221 10 12 10-12')}
    ${index ? `${label(350, 238, 'Stone')}<path class="guide-leader" d="M281 220H338"/>` : ''}`);
}

function joint(index) {
  return frame(index ? 'Cartilage changes in knee osteoarthritis' : 'Cartilage covers the bone ends', 'A simplified knee joint shows two bone ends with a smooth cartilage covering. The changed view shows thinner, uneven cartilage. It is not a stage or prediction for an individual knee.', `
    <path class="guide-tissue" d="M173 26H302L298 122Q330 150 300 166Q270 179 237 163Q207 181 177 162Q150 145 177 122Z"/>
    <path class="guide-tissue" d="M177 210Q209 194 237 206Q273 192 303 208L291 293H186Z"/>
    <path class="guide-cartilage" stroke-width="${index ? 5 : 17}" d="${index ? 'M174 160L197 166 215 162 233 169 255 162 279 170 302 161M177 210L198 206 218 212 240 207 265 207 287 204 303 209' : 'M176 164Q204 182 237 168Q274 180 302 166M179 205Q210 195 237 207Q273 194 301 205'}"/>
    <path class="guide-leader" d="M301 96H370M309 170H369M295 259H369"/>
    ${label(380, 102, 'Thighbone')}${label(378, 177, 'Cartilage')}${label(378, 266, 'Shinbone')}
    ${label(238, 320, index ? 'Uneven cartilage is one part of joint change' : 'Cartilage helps bones move smoothly', 'middle')}`);
}

function disc(index) {
  return frame(index ? 'Disc material can press on a nearby nerve' : 'Discs sit between vertebrae', 'A simplified side-view relationship shows two vertebrae separated by a disc. A nearby nerve is shown to the right. In the changed view disc material extends toward it.', `
    <rect class="guide-tissue" x="110" y="44" width="180" height="93" rx="24"/>
    <rect class="guide-tissue" x="110" y="190" width="180" height="93" rx="24"/>
    <path class="guide-soft" d="${index ? 'M119 143H274C295 143 298 151 317 151Q355 166 319 180C299 177 293 185 273 185H119Z' : 'M119 143H279Q302 163 279 185H119Z'}"/>
    <path class="guide-nerve" d="M340 28V289M340 167L412 224"/>
    <path class="guide-leader" d="M111 164H39M288 83H398"/>
    ${label(29, 145, 'Disc')}${label(402, 89, 'Vertebra')}${label(385, 249, 'Nerve')}
    ${index ? '<circle class="guide-focus" cx="328" cy="166" r="29"/>' : ''}
    ${label(260, 320, index ? 'Pressure or irritation can affect a nerve' : 'A disc acts as a cushion between bones', 'middle')}`);
}

function artery(index) {
  return frame(['An open artery', 'Plaque narrows an artery', 'A clot can form at disrupted plaque'][index], 'A lengthwise section of an artery shows the opening for blood. Plaque forms within the wall and narrows the opening. The final view adds a clot; it is a possible complication, not an inevitable next stage.', `
    <rect class="guide-tissue" x="54" y="75" width="412" height="177" rx="20"/>
    <path class="guide-space" d="M54 105H466V222H54Z"/>
    ${index ? '<path class="guide-plaque" d="M119 105Q192 112 209 140Q245 181 291 153Q326 120 394 105Z"/><path class="guide-plaque" d="M157 222Q239 178 322 222Z"/>' : ''}
    ${index === 2 ? '<path class="guide-obstruction" d="M268 149Q301 139 303 165Q340 170 317 191Q297 215 271 197Q244 186 268 149Z"/>' : ''}
    ${arrow(index === 2 ? 'M77 180H215' : 'M77 180H435', index === 2 ? 'm203 170 12 10-12 10' : 'm423 170 12 10-12 10')}
    <path class="guide-leader" d="M92 88V38H151"/>
    ${label(156, 43, 'Artery wall')}${label(71, 286, 'Blood flow →')}
    ${index ? `<path class="guide-leader" d="M225 131V36H290"/>${label(296, 41, 'Plaque in wall')}` : label(260, 157, 'Space for blood', 'middle')}
    ${index === 2 ? `<path class="guide-leader" d="M305 200L368 278"/>${label(372, 286, 'Clot')}` : ''}`);
}

function imagingReport(index) {
  const sections = ['Exam and comparison', 'Findings', 'Impression'];
  return frame('The sections of an imaging report', `A sample document highlights ${sections[index]}. The report separates exam context, observations, and the radiologist's summary. No patient findings are shown.`, `
    <rect class="guide-tissue" x="64" y="16" width="392" height="294" rx="14"/>
    ${label(260, 49, 'Anatomy of a report', 'middle')}
    ${sections.map((title, row) => `<rect class="${row === index ? 'guide-soft' : 'guide-space'}" x="88" y="${70 + row * 73}" width="344" height="60" rx="8"/>${label(260, 107 + row * 73, title, 'middle')}`).join('')}`);
}

function bloodPressure(index) {
  return frame('Two numbers in a blood pressure reading', ['The top number is highlighted: systolic pressure when the heart pumps.', 'The bottom number is highlighted: diastolic pressure between beats.', 'Both numbers belong to each reading. Repeated measurements help establish a pattern.'][index], `
    <rect class="guide-tissue" x="106" y="22" width="308" height="230" rx="25"/>
    <rect class="${index !== 1 ? 'guide-soft' : 'guide-space'}" x="130" y="49" width="260" height="73" rx="8"/>
    <rect class="${index !== 0 ? 'guide-soft' : 'guide-space'}" x="130" y="136" width="260" height="73" rx="8"/>
    ${label(154, 91, '120')}${label(252, 91, 'Systolic')}
    ${label(154, 179, '80')}${label(252, 179, 'Diastolic')}
    ${label(260, 236, 'Example only · mmHg', 'middle')}
    ${label(260, 285, ['Heart pumps', 'Heart relaxes between beats', 'Record both numbers each time'][index], 'middle')}`);
}

function electrocardiogram(index) {
  const parts = [
    { name: 'P wave', x: 112, width: 70 },
    { name: 'QRS', x: 213, width: 77 },
    { name: 'T wave', x: 333, width: 91 },
  ];
  const part = parts[index];
  return frame(`An illustrative ECG with the ${part.name} highlighted`, 'A schematic electrical signal has a small P wave, a sharp QRS complex, and a wider T wave. It has no calibrated time or voltage scale and cannot be used to judge a real tracing.', `
    <rect class="guide-soft" x="${part.x}" y="60" width="${part.width}" height="194" rx="10"/>
    <path class="guide-leader" d="M40 203H480"/>
    <path class="guide-cartilage" stroke-width="4" d="M40 203H112Q132 202 140 182Q149 164 161 185Q170 203 187 203H213L231 218L248 79L265 242L280 203H333Q350 203 365 171Q379 145 397 177Q409 203 424 203H480"/>
    ${parts.map(item => label(item.x + item.width / 2, 42, item.name, 'middle')).join('')}
    ${label(260, 297, 'Electrical activity over time →', 'middle')}`);
}

export const GUIDES = {
  blood_pressure: {
    intro: 'A cuff reading contains two pressures. Select a number to see what it describes.', diagram: bloodPressure,
    caption: 'Illustrative numbers · not your reading or a treatment target',
    tool: { key: 'bp_log_summary', label: 'Try the tool: home blood pressure log' },
    footer: 'Original educational diagram informed by NHS sources. A personal reading needs clinical context; thresholds and targets vary by setting and patient.',
    states: [
      state('Top number', 'Systolic: pressure as the heart pumps', 'The top number describes pressure when the heart pumps blood. Blood pressure is recorded in millimetres of mercury, written mmHg. The example is not a result from your body.', pressureTest, 'NHS · Blood pressure numbers'),
      state('Bottom number', 'Diastolic: pressure between beats', 'The bottom number describes pressure while the heart relaxes between beats. Both numbers matter when a clinician reviews a reading.', pressureTest, 'NHS · Blood pressure numbers'),
      state('Repeat readings', 'A pattern is more useful than one reading', 'Measurements may be repeated or recorded over several days or with a 24-hour monitor. Follow your clinician\'s and device\'s instructions and record both numbers. This illustration does not diagnose hypertension.', pressureCare, 'NHS · Confirming high blood pressure'),
    ],
    note: note('Can I tell from symptoms?', 'High blood pressure often causes no symptoms. Measurement is needed to detect it. Do not start, stop, or change a medicine based on this diagram.', pressureCare, 'NHS · Testing and treatment'),
    caution: note('', 'Persistent chest pain, or chest pain with sweating or breathlessness, needs emergency help. Do not wait for another blood pressure reading.', pressureCare, 'NHS · Emergency symptoms'),
  },
  ecg: {
    intro: 'Explore parts of a schematic electrical signal. This is not a tracing from a patient.', diagram: electrocardiogram,
    caption: 'Uncalibrated schematic · not a diagnostic reference',
    footer: 'Original educational diagram informed by MedlinePlus. The app cannot analyze an ECG image or waveform.',
    states: [
      state('P wave', 'The upper chambers activate', 'The P wave represents electrical activation of the upper heart chambers, called atria. An ECG records electrical activity through electrodes on the skin; it is not a picture of the heart.', ecgTest, 'MedlinePlus · ECG basics'),
      state('QRS', 'The lower chambers activate', 'The QRS complex represents electrical activation of the lower chambers, called ventricles. Clinicians consider the whole recording, symptoms, and other information when interpreting a result.', ecgTest, 'MedlinePlus · Reading an ECG'),
      state('T wave', 'The lower chambers recover electrically', 'The T wave represents the ventricles recovering electrically before the next beat. The shape here is illustrative, with no measured timing or voltage.', ecgTest, 'MedlinePlus · ECG signals'),
    ],
    note: note('Can one recording rule out a heart problem?', 'A short ECG records only a brief period. Intermittent symptoms may need longer monitoring. A normal-looking result does not explain away symptoms or replace clinical assessment.', ecgTest, 'MedlinePlus · Longer monitoring'),
    caution: note('', 'Chest pressure with sweating or breathlessness needs emergency care, even after a reassuring earlier test.', pressureCare, 'NHS · Emergency symptoms'),
  },
  radiology_report: {
    intro: 'Explore how a radiologist organizes a written report. This is a document guide, not a scan reader.', diagram: imagingReport,
    caption: 'Example report structure · no patient findings',
    footer: 'Original educational diagram informed by RadiologyInfo, from ACR, RSNA, and ASRT. This app explains text; it cannot inspect your images.',
    states: [
      state('Context', 'Start with the exam and comparison', 'The exam type and reason explain what was studied and why. The comparison section lists earlier images available to the radiologist. Missing earlier scans can limit what can be said about change.', radiology, 'RadiologyInfo · Report context'),
      state('Findings', 'Findings describe what was seen', 'This section records observations in the areas examined. Words such as possible or likely express uncertainty. An observation is not automatically the cause of a symptom.', radiology, 'RadiologyInfo · Findings'),
      state('Impression', 'The impression brings the findings together', 'The impression summarizes the key observations, possible explanations, and any recommended follow-up. Read it with the findings and discuss the next step with the clinician who ordered the test.', radiology, 'RadiologyInfo · Impression and follow-up'),
    ],
    note: note('What can I ask about my report?', 'You can paste the relevant wording without personal identifiers and ask what a term means. This app cannot examine an X-ray, CT, MRI, or ultrasound image, confirm a diagnosis, or replace the radiologist and your clinician.', radiology, 'RadiologyInfo · Discussing your results'),
  },
  asthma: {
    intro: 'Compare the space inside an airway. Select a view to see what changes.', diagram: airway,
    tool: { key: 'peak_flow_zone', label: 'Try the tool: peak-flow zone' },
    states: [
      state('Open airway', 'Air needs a clear passage', 'Air travels through the airways into and out of the lungs. This cross-section shows the opening surrounded by the airway wall.', `${nih}/asthma`, 'NHLBI · Asthma overview'),
      state('Narrowed airway', 'Less space makes breathing harder', 'During an asthma flare-up, swelling or tightening narrows the airways. This simplified comparison shows the reduced opening, not a measurement of lung function.', `${nih}/asthma/attacks`, 'NHLBI · Asthma attacks'),
    ],
    note: note('What does this explain?', 'The diagram explains narrowing in asthma. It cannot establish whether breathlessness or wheezing is caused by asthma. Management follows a clinician-created asthma action plan.', `${nih}/asthma/attacks`, 'NHLBI · Action plans and urgent care'),
    caution: note('', 'Severe difficulty breathing, or symptoms that do not improve with prescribed reliever medicine, need emergency care.', `${nih}/asthma/attacks`, 'NHLBI · When to get emergency help'),
  },
  reflux: {
    intro: 'A direction-of-flow comparison at the entrance to the stomach.', diagram: reflux,
    states: [
      state('Barrier', 'A barrier helps keep contents down', 'The lower esophageal sphincter and diaphragm help stop stomach contents from returning to the esophagus. The ring marks the sphincter; the diaphragm is omitted for clarity.', `${digestive}/acid-reflux-ger-gerd-adults/symptoms-causes`, 'NIDDK · Reflux mechanisms'),
      state('Backflow', 'Reflux moves contents upward', 'When the sphincter is weak or relaxes when it should not, stomach contents can move back into the esophagus. Repeated troublesome reflux can be part of GERD.', `${digestive}/acid-reflux-ger-gerd-adults/symptoms-causes`, 'NIDDK · Reflux symptoms and causes'),
    ],
    note: note('Does this identify the cause of pain?', 'No. The arrows explain reflux; they do not establish that chest or abdominal pain is reflux. Chest pain, trouble swallowing, or bleeding needs medical assessment.', `${digestive}/acid-reflux-ger-gerd-adults/symptoms-causes`, 'NIDDK · When to seek care'),
  },
  kidney_stones: {
    intro: 'Follow one kidney’s drainage route, then compare it with a blockage.', diagram: stone,
    states: [
      state('Urine route', 'The ureter connects kidney to bladder', 'Urine drains from a kidney through its ureter toward the bladder. Only one kidney and ureter are shown to make this route easier to follow.', `${urinary}/urinary-tract-how-it-works`, 'NIDDK · The urinary tract'),
      state('Blocked route', 'A lodged stone can obstruct urine', 'A stone can get stuck in the urinary tract and block urine flow. Some small stones pass with little or no pain; obstruction can cause severe pain or bleeding.', `${urinary}/kidney-stones/definition-facts`, 'NIDDK · Stones and obstruction'),
    ],
    note: note('Can this predict whether a stone will pass?', 'No. Actual stone size, position, composition, and the clinical situation affect treatment. This illustration exaggerates the stone for visibility and does not measure any of these.', `${urinary}/kidney-stones/definition-facts`, 'NIDDK · Stone types and care'),
    caution: note('', 'Seek care right away for severe pain, fever or chills, or trouble passing urine.', `${urinary}/kidney-stones/symptoms-causes`, 'NIDDK · Symptoms that need care'),
  },
  gallstones: {
    intro: 'See how the gallbladder connects to the route from liver to intestine.', diagram: gallbladder,
    states: [
      state('Bile route', 'The liver makes bile; the gallbladder stores it', 'Bile travels through ducts to the small intestine, where it helps digestion. The gallbladder stores bile and releases it into this route.', `${digestive}/gallstones/definition-facts`, 'NIDDK · The biliary tract'),
      state('Blocked duct', 'A stone can interrupt drainage', 'A gallstone can block a bile duct and cause an attack of pain. Many gallstones cause no symptoms when they do not obstruct the ducts. This is one possible blockage location.', `${digestive}/gallstones/definition-facts`, 'NIDDK · Gallstones and blockage'),
    ],
    note: note('Are these the same as kidney stones?', 'No. Gallstones form in the gallbladder and affect the biliary tract. The illustration shows a bile route, not the kidney-to-bladder route for urine.', `${digestive}/gallstones/definition-facts`, 'NIDDK · Gallstones explained'),
    caution: note('', 'Ongoing abdominal pain with fever, chills, or yellowing of the skin or eyes needs prompt medical attention.', `${digestive}/gallstones/symptoms-causes`, 'NIDDK · Warning signs'),
  },
  osteoarthritis: {
    intro: 'A knee example showing cartilage changes. Osteoarthritis affects the whole joint.', diagram: joint,
    states: [
      state('Joint surfaces', 'Cartilage covers the ends of bones', 'Cartilage provides a smooth covering where bones meet. This diagram leaves out other tissues to focus on the surfaces inside a knee joint.', `${joints}/osteoarthritis`, 'NIAMS · Joint structure'),
      state('Joint changes', 'Cartilage can become damaged', 'In osteoarthritis, cartilage and other joint tissues change. Pain, stiffness, and movement difficulties can occur. It is more than simple wear and tear, and the degree of change varies.', `${joints}/osteoarthritis`, 'NIAMS · Osteoarthritis'),
    ],
    note: note('Why show only part of the knee?', 'Osteoarthritis can also involve bone, the joint lining, and surrounding tissues. This simplified view does not grade severity, predict pain, or explain every type of arthritis.', `${joints}/osteoarthritis`, 'NIAMS · The whole joint'),
  },
  disc_nerve: {
    intro: 'Explore the relationship between a disc, neighboring bones, and a nerve.', diagram: disc,
    states: [
      state('Disc and nerve', 'Discs cushion the spine', 'Discs sit between vertebrae. The diagram separates a nearby nerve from the disc to make their relationship clear; it omits other spinal structures.', `${joints}/back-pain`, 'NIAMS · Spine structures'),
      state('Nerve pressure', 'A herniated disc can affect a nerve', 'Disc material that extends outward can compress or irritate a nearby nerve. The highlighted area shows this relationship, not a scan or proof of the cause of back or leg pain.', `${joints}/back-pain`, 'NIAMS · Disc and nerve problems'),
    ],
    note: note('Does back pain always come from a disc?', 'No. Back pain has many possible causes. Examination and history matter; this diagram cannot diagnose a herniated disc or decide whether an operation is needed.', `${joints}/back-pain`, 'NIAMS · Causes and assessment'),
    caution: note('', 'Back pain with trouble urinating, weakness, numbness, or fever needs medical assessment.', `${joints}/back-pain`, 'NIAMS · When to seek care'),
  },
  atherosclerosis: {
    intro: 'Compare the space for blood flow. A clot is a possible complication, not an inevitable next step.', diagram: artery,
    states: [
      state('Open artery', 'Blood flows through the artery', 'Arteries carry blood from the heart to the body. This lengthwise view shows the vessel wall and the opening through which blood travels.', `${nih}/atherosclerosis`, 'NHLBI · Arteries and blood flow'),
      state('Plaque', 'Plaque develops within the wall', 'Cholesterol, fat, and other material can form plaque in artery walls. Plaque can narrow the opening and reduce the supply of blood to tissues.', `${nih}/atherosclerosis`, 'NHLBI · Atherosclerosis'),
      state('Possible clot', 'Disrupted plaque can trigger a clot', 'If a plaque bursts, a clot can form and partly or completely block an artery. The consequences depend on which artery is affected. This illustration does not estimate anyone’s blockage or risk.', `${nih}/atherosclerosis`, 'NHLBI · Plaque and clotting'),
    ],
    note: note('Is this the same as a clot in a vein?', 'This guide shows arterial plaque. It does not illustrate a deep vein clot, measure blood flow, or select a medicine or procedure.', `${nih}/atherosclerosis`, 'NHLBI · What atherosclerosis means'),
  },
};
