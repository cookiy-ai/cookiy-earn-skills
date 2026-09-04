import type { DataSource } from '../core/markdown-contract.js';

export interface DataSummaryRecord {
  id: string;
  sources: DataSource[];
  sizeBytes: number;
  status: string;
  createdAt: string;
  duplicate?: boolean;
}

export interface ListDataSummariesResponse {
  items: DataSummaryRecord[];
  nextCursor?: string;
}

export interface CookiyIdentity {
  id?: string;
  userId?: string;
}
