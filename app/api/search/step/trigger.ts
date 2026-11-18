/** Fire the next step. The step route answers immediately and works in `after()`, so this returns fast. */
export async function triggerStep(origin: string, id: string) {
  await fetch(`${origin}/api/search/step`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-step-key": process.env.CRON_SECRET ?? "" },
    body: JSON.stringify({ id }),
    cache: "no-store",
  }).catch((e) => console.error("step trigger failed", e));
}
