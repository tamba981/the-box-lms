'use strict';

/**
 * Render sample certificates so the layout can be looked at.
 *
 * This is the loop the design needs: change a number in
 * `services/certificateRenderer.js`, run `npm run certificate:sample`, open the
 * PDF, see where the text landed. Text positions on a printed sheet cannot be
 * reasoned about to the millimetre — they have to be looked at.
 *
 *   npm run certificate:sample
 *   npm run certificate:sample -- --name "Nyenpuo Wureh-Gbessageh"
 *
 * Output goes to `backend/temp/`, which is gitignored.
 */

const fs = require('fs');
const path = require('path');

require('../src/config/env');

const { renderCertificate } = require('../src/services/certificateRenderer');

const OUT_DIR = path.join(__dirname, '..', 'temp');

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const studentName = arg('--name', 'John Doe');
  const courseName = arg('--course', 'Financial Literacy for Professionals');
  const certificateNumber = arg('--number', 'WGA-TEST-2026-0001');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Named after the student, so four samples can be compared without guessing
  // which file is which.
  const slug = studentName
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'sample';

  for (const credentialType of ['certificate', 'diploma']) {
    const { buffer, measurements } = await renderCertificate({
      studentName,
      courseName,
      certificateNumber,
      credentialType,
      issuedAt: new Date('2026-10-17T12:00:00Z'),
      verificationUrl: `https://wuteveglobalacademy.com/verify/sample-${credentialType}`,
    });

    const file = path.join(OUT_DIR, `sample-${slug}-${credentialType}.pdf`);
    fs.writeFileSync(file, buffer);

    process.stdout.write(
      `${credentialType.padEnd(12)} ${(buffer.length / 1024).toFixed(0)} KB  ` +
        `name ${measurements.nameSize}pt (${measurements.nameWidth.toFixed(0)}pt wide, centre ${measurements.nameInkCentre.toFixed(1)})  ` +
        `course ${measurements.courseSize}pt\n  -> ${path.relative(process.cwd(), file)}\n`
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
