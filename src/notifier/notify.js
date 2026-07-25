// Step 4 of the build order: push a real notification for alerted candidates.

export async function sendAlert(candidate) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('NTFY_TOPIC not set');

  // Using ntfy's JSON publish endpoint rather than the header-based one:
  // HTTP headers must be Latin-1/ASCII, and card names/prices routinely
  // contain characters (£, —, é, ♦) that break that encoding. JSON body
  // has no such restriction.
  const res = await fetch('https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      title: `${candidate.cardName} — £${candidate.listingPrice}`,
      message: `Avg £${candidate.targetPrice.toFixed(2)} · ${candidate.verdictReasoning ?? ''}`,
      click: candidate.listingUrl,
      priority: 4, // high
    }),
  });

  if (!res.ok) {
    throw new Error(`ntfy.sh notification failed: ${res.status} ${await res.text()}`);
  }
}
