import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PromptCardProps {
  prompt: string;
  promptVersion: string;
}

export function PromptCard({ prompt, promptVersion }: PromptCardProps) {
  return (
    <Card className="border-border/70 bg-white/60">
      <CardHeader>
        <CardTitle className="text-xl">Shared Evaluation Prompt</CardTitle>
        <CardDescription>Prompt version {promptVersion}</CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-36 rounded-md border border-border/60 bg-white/60 p-3">
          <pre className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{prompt}</pre>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
