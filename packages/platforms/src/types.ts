import type {
  MediaDescriptor,
  NormalizedMetric,
  Platform,
  PlatformMetadata,
  PublishResult,
} from "@scheduler/shared";

export interface AuthorizationRequest {
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
  scopes: string[];
  raw: Record<string, unknown>;
}

export interface AccountProfile {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  accountType?: string;
}

export interface PlatformCapabilities {
  platform: Platform;
  contentTypes: string[];
  supportsDirectPublicPublishing: boolean;
  requiresAppReview: boolean;
  supportsStatusPolling: boolean;
  supportsChunkedUpload: boolean;
  analyticsMetrics: string[];
  limitations: string[];
}

export interface PublishInput {
  accountId: string;
  accessToken: string;
  idempotencyKey: string;
  metadata: PlatformMetadata;
  media: MediaDescriptor[];
  deliveryUrls: string[];
  uploadSession?: {
    url: string;
    nextByte: number;
    totalBytes: number;
    remoteId?: string;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
  warnings: Array<{ field: string; message: string }>;
}

export interface PlatformError {
  code: string;
  message: string;
  retryable: boolean;
  ambiguous: boolean;
  httpStatus?: number;
}

export interface AnalyticsRequest {
  accountId: string;
  accessToken: string;
  remoteContentId?: string;
  startDate: string;
  endDate: string;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  getAuthorizationUrl(request: AuthorizationRequest): string;
  exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    verifier?: string,
  ): Promise<TokenSet>;
  refreshAccessToken(tokens: TokenSet): Promise<TokenSet>;
  disconnect(accessToken: string): Promise<void>;
  getAccountProfile(accessToken: string): Promise<AccountProfile>;
  getCapabilities(): PlatformCapabilities;
  validatePost(
    metadata: PlatformMetadata,
    media: MediaDescriptor[],
  ): ValidationResult;
  preflightPublish?(input: PublishInput): Promise<PublishResult | null>;
  publish(input: PublishInput): Promise<PublishResult>;
  getPublishStatus(
    accessToken: string,
    statusHandle: string,
  ): Promise<PublishResult>;
  fetchAnalytics(request: AnalyticsRequest): Promise<NormalizedMetric[]>;
  uploadThumbnail?(
    accessToken: string,
    videoId: string,
    body: BodyInit,
    mimeType: string,
  ): Promise<void>;
  normalizeError(error: unknown): PlatformError;
}

export type Fetch = typeof fetch;
