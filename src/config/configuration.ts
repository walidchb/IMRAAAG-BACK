export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  database: {
    // Note: transactions require a MongoDB replica set (not standalone).
    // The default localhost URI will cause withTransaction() to throw IllegalOperation on standalone.
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.EMAIL_FROM || 'noreply@imraaah.ma',
  },
  /**
   * Absolute origin of the vendor dashboard (scheme + host, no trailing slash). Used by
   * password-reset links and, unless `TEAM_ACCEPT_URL` overrides it, by team-invitation
   * links. Configure `FRONTEND_URL` in every environment — there is no baked-in domain.
   */
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/+$/, ''),
  /**
   * Team Management invitations. The raw token is only ever placed in the emailed accept URL;
   * `expiresAt` is enforced logically (there is no TTL index).
   */
  teamInvitation: {
    expiryHours: parseInt(process.env.TEAM_INVITATION_EXPIRY_HOURS || '48', 10),
    /** Optional absolute accept URL; when empty it is derived from `frontendUrl`. */
    acceptUrl: process.env.TEAM_ACCEPT_URL || '',
  },
  environment: process.env.NODE_ENV || 'development',
  deliveryEncryptionKey: process.env.DELIVERY_ENCRYPTION_KEY || '',
  r2: {
    endpoint: process.env.R2_ENDPOINT || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || 'imraaah',
    publicUrl: process.env.R2_PUBLIC_URL || '',
  },
  /**
   * The ZR Express status poller (roadmap §18.1).
   *
   * Off unless `ZR_STATUS_SYNC_ENABLED` says otherwise: the poller calls a third-party API, so
   * it never starts on its own. The interval, the call budget and the terminal-confirmation
   * count are the roadmap's defaults and can be tuned per deployment.
   */
  deliveryStatusSync: {
    enabled: process.env.DELIVERY_STATUS_SYNC_ENABLED === 'true',
    intervalMinutes: parseInt(process.env.DELIVERY_STATUS_SYNC_INTERVAL_MINUTES || '15', 10),
    maxCallsPerMinute: parseInt(
      process.env.DELIVERY_STATUS_SYNC_MAX_CALLS_PER_MINUTE || '20',
      10,
    ),
    jitterRatio: parseFloat(process.env.DELIVERY_STATUS_SYNC_JITTER_RATIO || '0.2'),
    terminalConfirmations: parseInt(
      process.env.DELIVERY_STATUS_SYNC_TERMINAL_CONFIRMATIONS || '3',
      10,
    ),
    leaseSeconds: parseInt(process.env.DELIVERY_STATUS_SYNC_LEASE_SECONDS || '120', 10),
    deliveredWatchDays: parseInt(
      process.env.DELIVERY_STATUS_SYNC_DELIVERED_WATCH_DAYS || '14',
      10,
    ),
    deliveredPollMinutes: parseInt(
      process.env.DELIVERY_STATUS_SYNC_DELIVERED_POLL_MINUTES || '60',
      10,
    ),
  },

  ecomStatusSync: {
    enabled: process.env.ECOM_STATUS_SYNC_ENABLED === 'true',
    intervalMinutes: parseInt(process.env.ECOM_STATUS_SYNC_INTERVAL_MINUTES || '15', 10),
    maxCallsPerMinute: parseInt(
      process.env.ECOM_STATUS_SYNC_MAX_CALLS_PER_MINUTE || '20',
      10,
    ),
    jitterRatio: parseFloat(process.env.ECOM_STATUS_SYNC_JITTER_RATIO || '0.2'),
    terminalConfirmations: parseInt(
      process.env.ECOM_STATUS_SYNC_TERMINAL_CONFIRMATIONS || '3',
      10,
    ),
    leaseSeconds: parseInt(process.env.ECOM_STATUS_SYNC_LEASE_SECONDS || '120', 10),
    deliveredWatchDays: parseInt(
      process.env.ECOM_STATUS_SYNC_DELIVERED_WATCH_DAYS || '14',
      10,
    ),
    deliveredPollMinutes: parseInt(
      process.env.ECOM_STATUS_SYNC_DELIVERED_POLL_MINUTES || '60',
      10,
    ),
  },

  dhdStatusSync: {
    enabled: process.env.DHD_STATUS_SYNC_ENABLED === 'true',
    intervalMinutes: parseInt(process.env.DHD_STATUS_SYNC_INTERVAL_MINUTES || '15', 10),
    maxCallsPerMinute: parseInt(
      process.env.DHD_STATUS_SYNC_MAX_CALLS_PER_MINUTE || '20',
      10,
    ),
    jitterRatio: parseFloat(process.env.DHD_STATUS_SYNC_JITTER_RATIO || '0.2'),
    terminalConfirmations: parseInt(
      process.env.DHD_STATUS_SYNC_TERMINAL_CONFIRMATIONS || '3',
      10,
    ),
    leaseSeconds: parseInt(process.env.DHD_STATUS_SYNC_LEASE_SECONDS || '120', 10),
    deliveredWatchDays: parseInt(
      process.env.DHD_STATUS_SYNC_DELIVERED_WATCH_DAYS || '14',
      10,
    ),
    deliveredPollMinutes: parseInt(
      process.env.DHD_STATUS_SYNC_DELIVERED_POLL_MINUTES || '60',
      10,
    ),
    utcOffset: process.env.DHD_STATUS_UTC_OFFSET || '+01:00',
    apiBase: process.env.DHD_STATUS_API_BASE || process.env.DHD_API_BASE || '',
    authMode: process.env.DHD_STATUS_AUTH_MODE || 'bearer',
  },

  /**
   * The DHD commune mapping gate. DHD/ECOTRACK exposes communes by `{ nom, wilaya_id }` (no UUID),
   * and an unmapped order would be rejected by DHD's dispatch API. When this is off, dispatch keeps
   * its legacy behaviour (resolve the commune name from the platform `communes` collection and send
   * it verbatim), so the feature rolls back instantly. Default `false`.
   */
  dhdCommuneMapping: {
    enabled: process.env.DHD_COMMUNE_MAPPING_ENABLED === 'true',
  },

  /**
   * The Noest commune mapping gate. Noest identifies communes by `{ nom, wilaya_id }` (no UUID) and
   * rejects an inactive/unknown commune at dispatch. When this is off, dispatch keeps its legacy
   * behaviour (resolve the commune name from the platform `communes` collection and send it
   * verbatim), so the feature rolls back instantly. Independent from `dhdCommuneMapping`.
   * Default `false`.
   */
  noestCommuneMapping: {
    enabled: process.env.NOEST_COMMUNE_MAPPING_ENABLED === 'true',
  },

  noestStatusSync: {
    enabled: process.env.NOEST_STATUS_SYNC_ENABLED === 'true',
    intervalMinutes: parseInt(process.env.NOEST_STATUS_SYNC_INTERVAL_MINUTES || '15', 10),
    maxCallsPerMinute: parseInt(
      process.env.NOEST_STATUS_SYNC_MAX_CALLS_PER_MINUTE || '20',
      10,
    ),
    jitterRatio: parseFloat(process.env.NOEST_STATUS_SYNC_JITTER_RATIO || '0.2'),
    terminalConfirmations: parseInt(
      process.env.NOEST_STATUS_SYNC_TERMINAL_CONFIRMATIONS || '3',
      10,
    ),
    leaseSeconds: parseInt(process.env.NOEST_STATUS_SYNC_LEASE_SECONDS || '120', 10),
    deliveredWatchDays: parseInt(
      process.env.NOEST_STATUS_SYNC_DELIVERED_WATCH_DAYS || '14',
      10,
    ),
    deliveredPollMinutes: parseInt(
      process.env.NOEST_STATUS_SYNC_DELIVERED_POLL_MINUTES || '60',
      10,
    ),
  },

  /**
   * Carrier shipping-label printing. Off by default: it renders carrier HTML/PDFs through a
   * browser and writes expiring artifacts to R2. `enabled` is the only switch; when it is on,
   * every store with label-capable carrier credentials can use the feature.
   */
  orderLabels: {
    enabled: process.env.ORDER_LABELS_ENABLED === 'true',
    maxOrders: parseInt(process.env.ORDER_LABELS_MAX_ORDERS || '100', 10),
    renderConcurrency: parseInt(process.env.ORDER_LABELS_RENDER_CONCURRENCY || '2', 10),
    carrierConcurrency: parseInt(process.env.ORDER_LABELS_CARRIER_CONCURRENCY || '5', 10),
    jobTimeoutMs: parseInt(process.env.ORDER_LABELS_JOB_TIMEOUT_MS || '90000', 10),
    renderTimeoutMs: parseInt(process.env.ORDER_LABELS_RENDER_TIMEOUT_MS || '15000', 10),
    artifactTtlHours: parseInt(process.env.ORDER_LABELS_ARTIFACT_TTL_HOURS || '24', 10),
    zrLabelApiBase:
      process.env.ZR_LABEL_API_BASE || 'https://api.zrexpress.app/api/v1',
    ecomLabelApiBase: process.env.ECOM_LABEL_API_BASE || 'https://ecom-dz.com/api_v2',
    dhdLabelApiBase:
      process.env.DHD_LABEL_API_BASE || 'https://platform.dhd-dz.com/api/v1',
    dhdLabelAuthMode: process.env.DHD_LABEL_AUTH_MODE || 'bearer',
    noestLabelApiBase:
      process.env.NOEST_LABEL_API_BASE || 'https://app.noest-dz.com',
    puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },

  zrStatusSync: {
    enabled: process.env.ZR_STATUS_SYNC_ENABLED === 'true',
    intervalMinutes: parseInt(process.env.ZR_STATUS_SYNC_INTERVAL_MINUTES || '15', 10),
    maxCallsPerMinute: parseInt(process.env.ZR_STATUS_SYNC_MAX_CALLS_PER_MINUTE || '20', 10),
    jitterRatio: parseFloat(process.env.ZR_STATUS_SYNC_JITTER_RATIO || '0.2'),
    terminalConfirmations: parseInt(process.env.ZR_STATUS_SYNC_TERMINAL_CONFIRMATIONS || '3', 10),
    leaseSeconds: parseInt(process.env.ZR_STATUS_SYNC_LEASE_SECONDS || '120', 10),
    deliveredWatchDays: parseInt(process.env.ZR_STATUS_SYNC_DELIVERED_WATCH_DAYS || '14', 10),
    deliveredPollMinutes: parseInt(
      process.env.ZR_STATUS_SYNC_DELIVERED_POLL_MINUTES || '60',
      10,
    ),
  },
});
