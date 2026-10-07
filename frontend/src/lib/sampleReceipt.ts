/**
 * Draws a sample gas receipt for the guided demo, dated on the quest's trip day.
 * It is labelled as a demo sample on its face, so it can never pass for a real purchase.
 */
export async function sampleReceipt(isoDate: string, tz: string): Promise<Blob> {
  const w = 520;
  const h = 760;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#111111";
  c.textBaseline = "top";
  const mono = (size: number, weight = "400") => (c.font = `${weight} ${size}px "Courier New", monospace`);
  const center = (t: string, y: number) => c.fillText(t, (w - c.measureText(t).width) / 2, y);
  const row = (l: string, r: string, y: number) => {
    c.fillText(l, 40, y);
    c.fillText(r, w - 40 - c.measureText(r).width, y);
  };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoDate));

  c.fillStyle = "#d7362a";
  c.fillRect(0, 0, w, 54);
  c.fillStyle = "#ffffff";
  mono(22, "700");
  center("SAMPLE RECEIPT, SIDEQUEST DEMO", 16);
  c.fillStyle = "#111111";
  mono(30, "700");
  center("ROUTE 9 FUEL", 90);
  mono(18);
  center("Fishkill, NY", 132);
  center(`Date ${date}   4:52 PM`, 162);
  c.fillRect(40, 204, w - 80, 2);
  mono(20);
  row("Unleaded 18.84 gal", "$71.40", 230);
  row("  @ $3.79 / gal", "", 260);
  row("E-ZPass reload", "$23.60", 300);
  c.fillRect(40, 350, w - 80, 2);
  mono(26, "700");
  row("TOTAL", "$95.00", 372);
  mono(18);
  row("Paid with card ending 4242", "", 420);
  c.fillRect(40, 470, w - 80, 2);
  mono(16);
  center("Not a real purchase.", 500);
  center("Generated for the guided demo only.", 526);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
}
