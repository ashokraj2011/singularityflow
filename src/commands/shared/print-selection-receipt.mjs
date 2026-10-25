/** Extracted command implementation; governance remains in the existing kernel APIs. */

export function printSelectionReceipt(receipt) {
  console.log(`Selection receipt: ${receipt.token}`);
  console.log(`Action: ${receipt.action} ${receipt.workId} · ${receipt.expiresAt ? `expires: ${receipt.expiresAt}` : 'valid while the review it holds is unchanged'}`);
  for (const choices of receipt.choiceSets) {
    const selected = receipt.answers?.[choices.id]?.id;
    console.log(`\n${choices.label}${selected ? ` — selected: ${selected}` : ''}`);
    for (const item of choices.options) console.log(`  ${item.id}\t${item.label}${item.description ? ` — ${item.description}` : ''}`);
  }
  console.log(`\nReady: ${receipt.ready ? 'yes' : 'no'}`);
}
