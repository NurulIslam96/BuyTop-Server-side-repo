const PDFDocument = require("pdfkit");

// Brand colors (Deep Indigo & Emerald), matching the client's daisyUI theme.
const BRAND_INDIGO = "#4f46e5";
const BRAND_EMERALD = "#059669";
const TEXT_DARK = "#1f2937";
const TEXT_MUTED = "#6b7280";

// PDFKit's built-in Helvetica font has no glyph for the Bengali Taka sign
// (৳, U+09F3) - it would render as a missing-character box. "Tk" is the
// safe plain-ASCII stand-in for PDF output. The client UI (which uses
// real system/web fonts) shows the ৳ symbol directly instead.
const fmtAmount = (n) => `Tk ${n}`;

/**
 * Streams a PDF invoice for a booking directly to an HTTP response.
 *
 * @param {import('express').Response} res
 * @param {Object} params
 * @param {Object} params.booking   The booking document.
 * @param {Array}  params.payments  Payment records (deposit and/or full) for this booking, oldest first.
 * @param {String} params.invoiceNumber  A human-friendly invoice number.
 */
function streamInvoicePDF(res, { booking, payments, invoiceNumber }) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="invoice-${invoiceNumber}.pdf"`
  );
  doc.pipe(res);

  // Header
  doc
    .fillColor(BRAND_INDIGO)
    .fontSize(24)
    .font("Helvetica-Bold")
    .text("BuyTop", 50, 50);
  doc
    .fillColor(TEXT_MUTED)
    .fontSize(10)
    .font("Helvetica")
    .text("Second-hand marketplace", 50, 78);

  doc
    .fillColor(TEXT_DARK)
    .fontSize(16)
    .font("Helvetica-Bold")
    .text("INVOICE", 400, 50, { align: "right" });
  doc
    .fillColor(TEXT_MUTED)
    .fontSize(10)
    .font("Helvetica")
    .text(`Invoice #: ${invoiceNumber}`, 300, 75, { width: 245, align: "right" })
    .text(`Date: ${new Date().toLocaleDateString()}`, 300, 90, {
      width: 245,
      align: "right",
    });

  doc.moveTo(50, 115).lineTo(545, 115).strokeColor("#e5e7eb").stroke();

  // Bill-to / product summary
  doc
    .fillColor(TEXT_DARK)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Billed To", 50, 130);
  doc
    .fillColor(TEXT_MUTED)
    .font("Helvetica")
    .text(booking.userName || "-", 50, 146)
    .text(booking.email || "-", 50, 160)
    .text(booking.phone || "-", 50, 174);

  doc
    .fillColor(TEXT_DARK)
    .font("Helvetica-Bold")
    .text("Item", 300, 130, { width: 245, align: "right" });
  doc
    .fillColor(TEXT_MUTED)
    .font("Helvetica")
    .text(booking.productName || "-", 300, 146, { width: 245, align: "right" })
    .text(booking.category || "-", 300, 160, { width: 245, align: "right" })
    .text(booking.location || "-", 300, 174, { width: 245, align: "right" });

  // Payments table
  let y = 220;
  doc
    .fillColor("#ffffff")
    .rect(50, y, 495, 24)
    .fill(BRAND_INDIGO);
  doc
    .fillColor("#ffffff")
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("Description", 60, y + 7)
    .text("Method", 250, y + 7)
    .text("Transaction ID", 340, y + 7)
    .text("Amount", 470, y + 7, { width: 65, align: "right" });

  y += 24;
  let total = 0;
  payments.forEach((p, i) => {
    const rowColor = i % 2 === 0 ? "#f4f4fb" : "#ffffff";
    doc.fillColor(rowColor).rect(50, y, 495, 22).fill();
    const label = p.type === "Deposit" ? "Booking deposit (10%)" : "Full payment";
    doc
      .fillColor(TEXT_DARK)
      .fontSize(9.5)
      .font("Helvetica")
      .text(label, 60, y + 6)
      .text(p.method || "-", 250, y + 6)
      .text(String(p.transactionId || "-"), 340, y + 6, { width: 120 })
      .text(fmtAmount(p.price), 460, y + 6, { width: 75, align: "right" });
    total += Number(p.price) || 0;
    y += 22;
  });

  y += 10;
  doc.moveTo(50, y).lineTo(545, y).strokeColor("#e5e7eb").stroke();
  y += 10;

  const fullPrice = Number(booking.price) || 0;
  const balanceDue = Math.max(fullPrice - total, 0);

  doc
    .fillColor(TEXT_MUTED)
    .fontSize(10)
    .font("Helvetica")
    .text("Item price:", 350, y, { width: 120, align: "right" })
    .fillColor(TEXT_DARK)
    .text(fmtAmount(fullPrice), 460, y, { width: 75, align: "right" });
  y += 16;
  doc
    .fillColor(TEXT_MUTED)
    .text("Total paid:", 350, y, { width: 120, align: "right" })
    .fillColor(BRAND_EMERALD)
    .font("Helvetica-Bold")
    .text(fmtAmount(total), 460, y, { width: 75, align: "right" });
  y += 16;
  doc
    .fillColor(TEXT_MUTED)
    .font("Helvetica")
    .text("Balance due:", 350, y, { width: 120, align: "right" })
    .fillColor(balanceDue > 0 ? "#e11d48" : TEXT_DARK)
    .text(fmtAmount(balanceDue), 460, y, { width: 75, align: "right" });

  doc
    .fillColor(TEXT_MUTED)
    .fontSize(9)
    .text(
      "Thank you for using BuyTop. This invoice was generated automatically and is valid without a signature.",
      50,
      740,
      { width: 495, align: "center" }
    );

  doc.end();
}

module.exports = { streamInvoicePDF };
