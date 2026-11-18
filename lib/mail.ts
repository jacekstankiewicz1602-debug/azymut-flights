// Alert mail through Resend's HTTP API (free tier). Needs RESEND_API_KEY and ALERT_EMAIL;
// without them alerts are skipped and the radar still lists everything.
export async function sendMail(subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY, to = process.env.ALERT_EMAIL;
  if (!key || !to) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.ALERT_FROM || "Azymut <onboarding@resend.dev>", to: [to], subject, text }),
  }).catch(() => null);
  return !!r?.ok;
}
