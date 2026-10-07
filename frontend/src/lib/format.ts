export function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
}

export function moneyShort(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : money(cents);
}

function parts(iso: string, tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(new Date(iso));
}

export function dayShort(iso: string, tz: string) {
  return parts(iso, tz, { weekday: "short", month: "short", day: "numeric" });
}

export function dayLong(iso: string, tz: string) {
  return parts(iso, tz, { weekday: "long", month: "long", day: "numeric" });
}

export function clock(iso: string, tz: string) {
  return parts(iso, tz, { hour: "numeric", minute: "2-digit" }).replace("AM", "am").replace("PM", "pm");
}

export function clock24(iso: string, tz: string) {
  return parts(iso, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function deadline(iso: string, tz: string) {
  return `${parts(iso, tz, { weekday: "short" })}, ${clock(iso, tz)}`;
}

export function relative(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const text = mins < 60 ? `${mins} min` : hours < 48 ? `${hours} hr` : `${days} days`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function timeAgo(iso: string, tz: string): string {
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? clock(iso, tz) : `${parts(iso, tz, { weekday: "short" })} ${clock(iso, tz)}`;
}

export function statusBoard(status: string, headcount: number, min: number, max: number): string {
  switch (status) {
    case "open":
      return `ABOARD ${headcount}/${min}`;
    case "on":
      return headcount >= max ? `FULL   ${headcount}/${max}` : `IT'S ON ${headcount}/${max}`;
    case "locked":
      return `CHARGED ${headcount}`;
    case "completed":
      return "ARRIVED";
    case "cancelled":
      return "CANCELLED";
    default:
      return status.toUpperCase();
  }
}

export function statusLine(status: string, headcount: number, min: number): string {
  switch (status) {
    case "open":
      return `${headcount} of ${min} needed`;
    case "on":
      return "It's on";
    case "locked":
      return "Locked and charged";
    case "completed":
      return "Trip done";
    case "cancelled":
      return "Didn't run";
    default:
      return status;
  }
}
