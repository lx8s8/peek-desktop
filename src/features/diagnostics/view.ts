export interface DiagnosticView {
  runId: string;
  search: string;
  level: string;
  source: string;
  tag: string;
  emitter: string;
  grouped: boolean;
  fingerprint: string | null;
  following: boolean;
}
export const emptyDiagnosticView: DiagnosticView = {
  runId: "",
  search: "",
  level: "all",
  source: "",
  tag: "",
  emitter: "",
  grouped: false,
  fingerprint: null,
  following: true,
};
