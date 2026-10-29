#!/usr/bin/env node
/*
 * Configure the R2 lifecycle rule that expires private shipping-label artifacts.
 *
 * The rule is scoped to the `order-labels/` prefix and expires objects after
 * `ORDER_LABELS_ARTIFACT_TTL_HOURS` (default 24), rounded up to whole days. Other
 * lifecycle rules in the bucket are preserved. There is no delete step: an R2 lifecycle
 * rule is the only thing that removes these objects, and the app never publishes them.
 *
 * Usage:
 *   node scripts/configure-r2-label-lifecycle.js             # dry run
 *   node scripts/configure-r2-label-lifecycle.js --apply     # read, merge, write
 *   node scripts/configure-r2-label-lifecycle.js --verify    # read-only check
 *
 * Exit codes:
 *   0  dry run / apply / verify succeeded
 *   1  configuration or bucket error, or verification failed
 */

'use strict';

require('dotenv').config();

const {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');

const PREFIX = 'order-labels/';

function ttl() {
  const raw = Number.parseInt(process.env.ORDER_LABELS_ARTIFACT_TTL_HOURS || '24', 10);
  const hours = Number.isFinite(raw) && raw > 0 ? Math.min(168, raw) : 24;
  // R2 lifecycle expiration is day-granular. Round up so an artifact never expires early.
  return { hours, days: Math.max(1, Math.ceil(hours / 24)) };
}

const { hours: TTL_HOURS, days: EXPIRATION_DAYS } = ttl();
const RULE_ID = `order-labels-expire-${EXPIRATION_DAYS}-day`;

function fail(message, err) {
  console.error(`[ORDER LABEL LIFECYCLE] ${message}`);
  if (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[ORDER LABEL LIFECYCLE] ${detail}`);
  }
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`Missing required environment variable ${name}.`);
  return value;
}

function createClient() {
  return new S3Client({
    region: 'auto',
    endpoint: required('R2_ENDPOINT'),
    credentials: {
      accessKeyId: required('R2_ACCESS_KEY_ID'),
      secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  });
}

function desiredRule() {
  return {
    ID: RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: PREFIX },
    Expiration: { Days: EXPIRATION_DAYS },
  };
}

function rulePrefix(rule) {
  if (rule?.Filter?.Prefix) return String(rule.Filter.Prefix);
  if (rule?.Filter?.And?.Prefix) return String(rule.Filter.And.Prefix);
  if (rule?.Prefix) return String(rule.Prefix);
  return '';
}

function isOurRule(rule) {
  return rule?.ID === RULE_ID || rulePrefix(rule) === PREFIX;
}

function mergeRules(existing) {
  const preserved = (existing ?? []).filter((rule) => !isOurRule(rule));
  return [...preserved, desiredRule()];
}

async function readRules(client, bucket) {
  try {
    const current = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    return { rules: Array.isArray(current.Rules) ? current.Rules : [] };
  } catch (err) {
    const name = err?.name || '';
    const status = err?.$metadata?.httpStatusCode;
    if (name === 'NoSuchLifecycleConfiguration' || status === 404) {
      return { rules: [] };
    }
    throw err;
  }
}

function isDesired(rule) {
  return (
    rule?.ID === RULE_ID &&
    rule?.Status === 'Enabled' &&
    rulePrefix(rule) === PREFIX &&
    rule?.Expiration?.Days === EXPIRATION_DAYS
  );
}

async function main() {
  const apply = process.argv.includes('--apply');
  const verify = process.argv.includes('--verify');
  if (apply && verify) fail('Use either --apply or --verify, not both.');

  const bucket = required('R2_BUCKET');
  const client = createClient();
  const current = await readRules(client, bucket);
  const nextRules = apply ? mergeRules(current.rules) : current.rules;
  const configured = nextRules.find(isDesired);

  console.log(`[ORDER LABEL LIFECYCLE] bucket: ${bucket}`);
  console.log(`[ORDER LABEL LIFECYCLE] prefix: ${PREFIX}`);
  console.log(`[ORDER LABEL LIFECYCLE] rule: ${RULE_ID}, expire after ${EXPIRATION_DAYS} day(s) (${TTL_HOURS}h configured)`);
  console.log(`[ORDER LABEL LIFECYCLE] existing rules: ${current.rules.length}`);

  if (verify) {
    if (!configured) fail('The order-label lifecycle rule is not configured as required.');
    console.log('[ORDER LABEL LIFECYCLE] verify: OK');
    return;
  }

  if (!apply) {
    console.log('[ORDER LABEL LIFECYCLE] dry run only; pass --apply to write this configuration.');
    console.log(JSON.stringify({ Rules: nextRules }, null, 2));
    return;
  }

  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: nextRules },
    }),
  );

  const after = await readRules(client, bucket);
  if (!(after.rules ?? []).find(isDesired)) {
    fail('R2 accepted the write but the expected rule was not returned on re-read.');
  }

  console.log(`[ORDER LABEL LIFECYCLE] applied; ${after.rules.length} rule(s) now present.`);
  console.log('[ORDER LABEL LIFECYCLE] OK');
}

main().catch((err) => fail('Lifecycle configuration failed.', err));
