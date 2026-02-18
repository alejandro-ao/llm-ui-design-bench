import { EvaluatorClient } from "@/components/evaluator-client";
import { PROMPT_VERSION, SHARED_PROMPT } from "@/lib/prompt";

export default function Home() {
  return (
    <main className="h-[100dvh] min-h-0 overflow-hidden">
      <EvaluatorClient prompt={SHARED_PROMPT} promptVersion={PROMPT_VERSION} />
    </main>
  );
}
