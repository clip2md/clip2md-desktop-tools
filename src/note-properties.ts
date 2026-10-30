/** Source-backed metric fields reused from the hybrid branch. */
export const METRIC_KEYS = [
  "views",
  "likes",
  "collects",
  "comments",
  "shares",
  "coins",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type MetricSnapshot = Partial<Record<MetricKey, number>> & {
  metrics_captured_at: string;
};
