import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PreviewFrameProps {
  html: string | null;
  title: string;
  loading: boolean;
  errorMessage: string | null;
}

export function PreviewFrame({ html, title, loading, errorMessage }: PreviewFrameProps) {
  return (
    <Card className="overflow-hidden border-border/70 bg-white/70">
      <CardHeader>
        <CardTitle className="text-xl">Generated Preview</CardTitle>
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="min-h-[500px] overflow-hidden rounded-lg border border-border/60 bg-white">
          {loading ? (
            <div className="grid min-h-[500px] place-items-center text-sm text-muted-foreground">
              Loading artifact...
            </div>
          ) : null}

          {!loading && errorMessage ? (
            <div className="grid min-h-[500px] place-items-center px-6 text-center text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}

          {!loading && !errorMessage && !html ? (
            <div className="grid min-h-[500px] place-items-center px-6 text-center text-sm text-muted-foreground">
              Artifact not available yet for this model.
            </div>
          ) : null}

          {!loading && !errorMessage && html ? (
            <iframe
              title={title}
              sandbox="allow-scripts"
              srcDoc={html}
              className="h-[78vh] min-h-[500px] w-full"
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
