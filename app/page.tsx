import { EvaluatorClient } from "@/components/evaluator-client";
import { PROMPT_VERSION, SHARED_PROMPT } from "@/lib/prompt";

export default function Home() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <section className="rounded-3xl border border-border/60 bg-card/90 p-6 shadow-xl shadow-black/5 backdrop-blur sm:p-10">
        <div className="mb-8 flex flex-col gap-4">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Frontend Evals
          </p>
          <h1 className="text-4xl leading-tight font-semibold text-balance sm:text-5xl">
            Which model redesigns a weak landing page best?
          </h1>
          <p className="max-w-3xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Every model receives the exact same instruction. Pick one from the dropdown
            and inspect the generated HTML output. This MVP is static-first and seeded
            with baseline, Kimi, and MiniMax artifacts.
          </p>
        </div>

        <EvaluatorClient prompt={SHARED_PROMPT} promptVersion={PROMPT_VERSION} />
      </section>
    </main>
  );
}
