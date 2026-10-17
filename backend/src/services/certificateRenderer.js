'use strict';

/**
 * Certificate rendering.
 *
 * A certificate is not a web page. It is a fixed image, three lines of text and
 * a QR code, at a fixed size, and the output has to be byte-for-byte repeatable.
 * `pdf-lib` draws exactly that, in about a megabyte of pure JavaScript, with no
 * browser to download and no `--no-sandbox` flag in a container that holds
 * student records.
 *
 * Everything positional below was measured from the artwork rather than
 * estimated: the page is scanned for dark pixel bands to find where each line of
 * printed text sits, and the QR is bounded by scanning for its modules. The
 * numbers are expressed as fractions of the sheet so that replacing the artwork
 * at a different resolution does not move anything.
 *
 * Two things in the printed artwork are handled rather than ignored:
 *
 *   - The QR code is already printed on the sheet. It is the *same* QR on every
 *     certificate, which would make every certificate verifiable as every other
 *     one. It is painted over with the sheet's own background colour — the area
 *     around it is a flat #F2F2F2, so the patch is invisible — and the real code
 *     is drawn in exactly that space.
 *   - "Certificate number:" is printed and can be used as-is, so the number is
 *     drawn to the right of it on the same baseline.
 */

const fs = require('fs/promises');
const path = require('path');

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');

const logger = require('../lib/logger');
const config = require('../config/env');

/** A4 landscape in PDF points: 842 × 595. */
const PAGE = { width: 842, height: 595 };

/** Where the artwork lives. Outside `public/`, so it is never web-served. */
const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'assets', 'certificates');

const TEMPLATES = {
  certificate: 'certificate-template.jpg',
  diploma: 'diploma-template.jpg',
};

/**
 * Measured geometry, as a fraction of the sheet (0,0 = top left).
 *
 * `name` and `course` are the blank bands the artwork leaves for them; the rest
 * are printed elements that the renderer has to sit exactly on top of.
 */
const LAYOUT = {
  name: { top: 0.301, bottom: 0.442 },

  /**
   * The clear space between the word "in" and the gold ornament.
   *
   * The band used to run to 0.724, which is past the bottom of the ornament —
   * it centred the course name on top of the decorative motif instead of in the
   * space above it. The ornament was located by scanning for gold pixels:
   *
   *   gold rule above          55.85 .. 56.17 %
   *   "in" (last body line)    58.10 .. 59.12 %
   *   ornament apex            66.98 %        <- band must stop here
   *   ornament body            68.02 .. 70.77 %
   *   ornament bottom          71.81 %
   *
   * Its horizontal centre is 61.5 %, which independently confirms the column
   * axis: the motif is centred on the text column, not on the page.
   */
  course: { top: 0.5912, bottom: 0.6698 },

  qr: { left: 0.2098, top: 0.7243, size: 0.1631 },
  number: { left: 0.292, baseline: 0.933 },

  /**
   * The printed sentence ends "…academic excellence. has successfully completed
   * the course in…" — a full stop where the grammar needs a comma.
   *
   * It is burnt into the sheet, so it is corrected at render time rather than
   * ignored: a grammar error on every certificate the academy ever issues is a
   * permanent credibility problem, and no one has the source artwork any more.
   *
   * The full stop was located by scanning the line for glyphs and picking the
   * only one that is dot-sized — 9 px wide by 8 px tall, sitting on the
   * baseline, against 28–32 px letters 36 px tall. It is at exactly the same
   * place on both sheets, so one measurement serves both.
   *
   * The patch is about 1.3 mm × 1.0 mm on a printed A4, over a flat #F2F2F2
   * area, and a comma is drawn on the same baseline in the same ink.
   */
  punctuation: {
    mask: { left: 0.5340, right: 0.5390, top: 0.5290, bottom: 0.5348 },
    x: 0.5351,
    baseline: 0.53387,
    size: 12,
  },
};

/** Ink and paper, sampled from the artwork. */
const INK = rgb(0x13 / 255, 0x1d / 255, 0x45 / 255);
const PAPER = rgb(0xf2 / 255, 0xf2 / 255, 0xf2 / 255);

/**
 * The horizontal axis the name and course are centred on.
 *
 * NOT the middle of the sheet. The artwork reserves its left fifth for the gold
 * banner and the foil seal, and centres its prose in the space that remains.
 * Three independent measurements of the printed body text agree on 61.5%:
 *
 *   paragraph line 1   32.33% .. 90.56%   centre 61.45%
 *   paragraph line 3   35.52% .. 87.49%   centre 61.51%
 *   short word, line 4 61.06% .. 62.37%   centre 61.72%
 *
 * The last one is decisive: a single short word in a centred column sits
 * exactly on the column's centre. Centring on 50% instead put the name 97 pt to
 * the left of the paragraph it belongs to — measurable, and visible.
 */
const TEXT_COLUMN = 0.616;

/** Where the outer decorative rule begins, measured from the artwork. */
const BORDER_RIGHT = 0.9558;

/**
 * The widest a single line may be.
 *
 * Derived from the space that actually exists: twice the distance from the
 * column centre to the border, so a long name cannot run off the sheet or into
 * the frame. Not a percentage of the page chosen for taste — 80% of the page
 * would put the right edge 13 pt past the paper.
 */
const MAX_LINE_WIDTH = 2 * (BORDER_RIGHT * PAGE.width - TEXT_COLUMN * PAGE.width);

/** Start and floor sizes, approved for each line. */
const SIZES = {
  name: { start: 60, floor: 40 },
  course: { start: 36, floor: 24 },
};

/**
 * The standard PDF fonts cover WinAnsi only.
 *
 * A name written in a script outside that range would make `drawText` throw, and
 * a certificate that fails to render because of the student's name is worse than
 * one that renders imperfectly. Anything unencodable is replaced and logged, so
 * the failure is visible in the log rather than silent. Embedding a Unicode font
 * is the real fix and needs the font files approved first.
 */
function sanitisable(value) {
  const text = String(value == null ? '' : value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // Everything WinAnsi cannot encode becomes "?" rather than throwing.
  const safe = text.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '?');

  if (safe !== text) {
    logger.warn('certificate text contained characters the standard fonts cannot encode', {
      original: text,
    });
  }

  return safe;
}

/** Convert a fraction measured from the top of the sheet into a PDF y value. */
function fromTop(fraction) {
  return PAGE.height - fraction * PAGE.height;
}

/**
 * Draw a line centred on the artwork's text column.
 *
 * Returns what it actually drew, so the caller (and the tests) can check the
 * result rather than trusting the intent.
 */
function drawCentred(page, text, font, options) {
  const { start, floor, bandTop, bandBottom } = options;
  const content = sanitisable(text);

  if (!content) {
    return { size: start, width: 0, inkCentre: TEXT_COLUMN * PAGE.width };
  }

  // Shrink in whole steps until it fits, but never past the floor: a name cut
  // down to an unreadable size is worse than one that sits close to the rule.
  let size = start;
  while (size > floor && font.widthOfTextAtSize(content, size) > MAX_LINE_WIDTH) {
    size -= 2;
  }

  const width = font.widthOfTextAtSize(content, size);

  // Cap height, not line height. The eye centres the capital letters, not the
  // empty space a descender would occupy, so the caps are centred in the band
  // and the baseline falls half a cap height below that centre.
  const capHeight = font.heightAtSize(size, { descender: false });
  const baseline = fromTop((bandTop + bandBottom) / 2) - capHeight / 2;

  const inkCentre = TEXT_COLUMN * PAGE.width;
  const x = inkCentre - width / 2;

  page.drawText(content, { x, y: baseline, size, font, color: INK });

  return { size, width, inkCentre };
}

/**
 * Render one certificate to a PDF buffer.
 *
 * @param {object} input
 * @param {string} input.studentName
 * @param {string} input.courseName
 * @param {string} input.certificateNumber
 * @param {'certificate'|'diploma'} [input.credentialType]
 * @param {Date} [input.issuedAt]
 * @param {string} [input.verificationUrl] the URL the QR code points at
 * @returns {Promise<Buffer>}
 */
async function renderCertificate({
  studentName,
  courseName,
  certificateNumber,
  credentialType = 'certificate',
  issuedAt,
  verificationUrl,
}) {
  const templateName = TEMPLATES[credentialType] || TEMPLATES.certificate;
  const templatePath = path.join(TEMPLATE_DIR, templateName);

  const templateBytes = await fs.readFile(templatePath);

  const pdf = await PDFDocument.create();

  pdf.setTitle(`${sanitisable(courseName)} - ${sanitisable(studentName)}`);
  pdf.setSubject(`Wuteve Global Academy ${credentialType}`);
  pdf.setAuthor('Wuteve Global Academy');
  pdf.setCreator('Wuteve Global Academy');
  pdf.setProducer('Wuteve Global Academy');
  pdf.setCreationDate(issuedAt instanceof Date ? issuedAt : new Date());

  const page = pdf.addPage([PAGE.width, PAGE.height]);

  // 1. The artwork, edge to edge. A4 landscape and the sheet are the same
  //    shape, so this is an exact fit rather than a stretch.
  const background = await pdf.embedJpg(templateBytes);
  page.drawImage(background, { x: 0, y: 0, width: PAGE.width, height: PAGE.height });

  // Two faces on purpose: the headings are bold, and the printed certificate
  // number keeps the regular face it has always had.
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);

  // 1b. Correct the printed sentence's full stop into a comma. See LAYOUT.
  const dot = LAYOUT.punctuation;

  page.drawRectangle({
    x: dot.mask.left * PAGE.width,
    y: fromTop(dot.mask.bottom),
    width: (dot.mask.right - dot.mask.left) * PAGE.width,
    height: (dot.mask.bottom - dot.mask.top) * PAGE.height,
    color: PAPER,
  });

  page.drawText(',', {
    x: dot.x * PAGE.width,
    y: fromTop(dot.baseline),
    size: dot.size,
    font: regular,
    color: INK,
  });

  // 2. The student's name, in the blank band between "This is to certify that"
  //    and "who has demonstrated outstanding performance...".
  const name = drawCentred(page, studentName, bold, {
    ...SIZES.name,
    bandTop: LAYOUT.name.top,
    bandBottom: LAYOUT.name.bottom,
  });

  // 3. The course, in the blank space after "...completed the course in".
  const course = drawCentred(page, courseName, bold, {
    ...SIZES.course,
    bandTop: LAYOUT.course.top,
    bandBottom: LAYOUT.course.bottom,
  });

  // 4. The QR code, over the printed one.
  //
  //    The printed QR is identical on every sheet, so it is not merely useless
  //    — it is a false credential. The patch is the sheet's own flat background
  //    colour, measured at #F2F2F2, and the space around the code is plain, so
  //    nothing shows.
  const qrBox = {
    x: LAYOUT.qr.left * PAGE.width,
    width: LAYOUT.qr.size * PAGE.height,
    height: LAYOUT.qr.size * PAGE.height,
    y: fromTop(LAYOUT.qr.top + LAYOUT.qr.size),
  };

  page.drawRectangle({
    x: qrBox.x,
    y: qrBox.y,
    width: qrBox.width,
    height: qrBox.height,
    color: PAPER,
  });

  const target =
    verificationUrl ||
    certificateNumber; // caller should pass a URL; the number is the fallback

  const qrPng = await QRCode.toBuffer(String(target), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
  });

  const qrImage = await pdf.embedPng(qrPng);
  page.drawImage(qrImage, {
    x: qrBox.x,
    y: qrBox.y,
    width: qrBox.width,
    height: qrBox.height,
  });

  // 5. The number, on the baseline of the printed "Certificate number:" label.
  page.drawText(sanitisable(certificateNumber), {
    x: LAYOUT.number.left * PAGE.width,
    y: fromTop(LAYOUT.number.baseline),
    size: 11,
    font: regular,
    color: INK,
  });

  const bytes = await pdf.save();

  return {
    buffer: Buffer.from(bytes),
    measurements: {
      credentialType,
      template: templateName,
      nameSize: name.size,
      courseSize: course.size,
      nameInkCentre: name.inkCentre,
      courseInkCentre: course.inkCentre,
      nameWidth: name.width,
      courseWidth: course.width,
      nameFont: bold.name,
      columnCentre: TEXT_COLUMN * PAGE.width,
      qr: qrBox,
      target: String(target),
    },
  };
}

module.exports = {
  renderCertificate,
  PAGE,
  LAYOUT,
  TEMPLATE_DIR,
  buildVerificationUrl(verificationCode) {
    const base = (config.publicBaseUrl || 'https://wuteveglobalacademy.com').replace(/\/+$/, '');
    return `${base}/verify/${encodeURIComponent(verificationCode)}`;
  },
};
