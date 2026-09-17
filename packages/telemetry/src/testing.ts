import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-node';

/** Test-only recorder of sanitised spans (O8-5: in-memory exporter in tests only). */
export function createSpanRecorder() {
  const exporter = new InMemorySpanExporter();
  return {
    processor: new SimpleSpanProcessor(exporter),
    spans: (): ReadableSpan[] => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    /** Everything a telemetry backend could ever receive, as text, for leak assertions. */
    dump: (): string =>
      JSON.stringify(
        exporter.getFinishedSpans().map((span) => ({
          name: span.name,
          attributes: span.attributes,
          events: span.events,
          status: span.status,
          links: span.links,
          resource: span.resource.attributes,
          scope: span.instrumentationScope,
        })),
      ),
  };
}
