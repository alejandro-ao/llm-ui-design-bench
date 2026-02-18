import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PromptCardProps {
  prompt: string;
  promptVersion: string;
}

export function PromptCard({ prompt, promptVersion }: PromptCardProps) {
  return (
    <Card className="gap-3 py-3">
      <CardHeader className="px-3">
        <CardTitle className="text-sm">Shared Prompt</CardTitle>
        <CardDescription className="text-xs">v{promptVersion}</CardDescription>
      </CardHeader>
      <CardContent className="px-3">
        <ScrollArea className="h-36 rounded-lg bg-muted p-3">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">{prompt}</pre>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
