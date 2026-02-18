interface PreviewFrameProps {
  html: string | null;
  title: string;
  loading: boolean;
  errorMessage: string | null;
}

export function PreviewFrame({ html, title, loading, errorMessage }: PreviewFrameProps) {
  return (
    <div className="relative h-full min-h-[62vh] bg-white lg:min-h-0">
      {loading ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white/70 text-sm text-muted-foreground">
          Loading artifact...
        </div>
      ) : null}

      {!loading && errorMessage ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white px-6 text-center text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      {!loading && !errorMessage && !html ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white px-6 text-center text-sm text-muted-foreground">
          Artifact not available yet for this model.
        </div>
      ) : null}

      {!loading && !errorMessage && html ? (
        <iframe
          title={title}
          sandbox="allow-scripts"
          srcDoc={html}
          className="h-full min-h-[62vh] w-full bg-white lg:min-h-0"
        />
      ) : null}
    </div>
  );
}
