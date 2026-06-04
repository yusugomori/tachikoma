import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import {
  createProjectSnapshot,
  type ProjectSnapshot,
  renderProjectSnapshotJson,
  renderProjectSnapshotMarkdown
} from "../exports/index.js";
import type { ServiceContext } from "./context.js";
import { parseCommandInput } from "./validation.js";

const exportReportInputSchema = z.object({
  id: z.string().min(1).optional(),
  path: z.string().min(1),
  format: z.enum(["markdown", "json"])
});

const renderReportInputSchema = z.object({
  format: z.enum(["markdown", "json"]).default("markdown")
});

export type ExportReportInput = z.input<typeof exportReportInputSchema>;
export type RenderReportInput = z.input<typeof renderReportInputSchema>;

export interface RenderedReport {
  format: "markdown" | "json";
  content: string;
  snapshot: ProjectSnapshot;
}

export class ReportService {
  public constructor(private readonly context: ServiceContext) {}

  public snapshot(): ProjectSnapshot {
    return createProjectSnapshot({
      projections: this.context.projections(),
      events: this.context.events(),
      generatedAt: this.context.now()
    });
  }

  public render(input: RenderReportInput = {}): RenderedReport {
    const parsed = parseCommandInput(renderReportInputSchema, input);
    const snapshot = this.snapshot();

    return {
      format: parsed.format,
      snapshot,
      content:
        parsed.format === "json"
          ? renderProjectSnapshotJson(snapshot)
          : renderProjectSnapshotMarkdown(snapshot)
    };
  }

  public export(input: ExportReportInput): EventEnvelope {
    const parsed = parseCommandInput(exportReportInputSchema, input);
    const reportId = parsed.id ?? this.context.id("report");

    return this.context.appendEvent({
      type: "report.exported",
      target: {
        reportId
      },
      payload: {
        path: parsed.path,
        format: parsed.format
      }
    });
  }
}
