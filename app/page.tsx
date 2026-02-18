import { EvaluatorClient } from "@/components/evaluator-client";
import { PROMPT_VERSION, SHARED_PROMPT } from "@/lib/prompt";

export default function Home() {
  return (
    <main className="h-[100dvh] p-3 sm:p-4">
      <EvaluatorClient prompt={SHARED_PROMPT} promptVersion={PROMPT_VERSION} />
    </main>
  );
}
