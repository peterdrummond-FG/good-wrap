// Stage 5 CLI: ask a natural-language question across all processed meetings.
//
// Usage:
//   npm run ask -- "What did we decide about the budget?"

import { askQuestion } from "./askQuestion";
import { runCli } from "../util/runCli";

async function main() {
  const question = process.argv.slice(2).join(" ");
  if (!question.trim()) {
    throw new Error('Usage: npm run ask -- "your question here"');
  }

  const result = await askQuestion(question);

  console.log("\n" + result.answer + "\n");
  if (result.sources.length > 0) {
    console.log("Sources:");
    for (const s of result.sources) {
      console.log(`  - ${s.topic} (${s.startTime.toISOString().slice(0, 10)})`);
    }
  } else {
    console.log("(no sources cited)");
  }
}

runCli("Ask", main);
