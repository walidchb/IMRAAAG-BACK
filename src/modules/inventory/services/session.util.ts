import { LoggerService } from '@nestjs/common';
import { ClientSession, Model } from 'mongoose';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

/**
 * Opens a session and verifies this deployment can actually run transactions.
 *
 * The probe is a real `startTransaction` on a throwaway session, never the caller's: callers
 * hand the returned session to `withTransaction`, which starts its own transaction, and
 * starting one here first left the session mid-transaction ("Transaction already in
 * progress"). The probe session is always ended before this returns.
 *
 * A misconfigured single-node `mongod` fails here with a message about transaction numbers,
 * which is an infrastructure problem rather than a bug in the caller. Surfacing it as a
 * typed exception means a reservation failure reads as a configuration fault instead of a
 * 500 from deep inside the driver.
 */
export async function openTransactionSession(
  model: Model<any>,
  logger: LoggerService,
): Promise<ClientSession> {
  const probe = await model.startSession();
  try {
    await probe.startTransaction();
    await probe.abortTransaction();
  } catch (err: any) {
    await probe.endSession().catch(() => undefined);
    if (
      /replica set|transaction numbers|Transaction numbers are only allowed/i.test(
        String(err?.message ?? ''),
      )
    ) {
      logger.error(
        'MongoDB is not running as a replica set; multi-document transactions are unavailable. ' +
          'See the replica-set requirement in src/config/configuration.ts.',
      );
      throw new AppException(AppErrorCode.INVALID_COMBINATION, {
        reason: 'transactions_unavailable',
        detail: 'MongoDB must run as a replica set for multi-document transactions.',
      });
    }
    throw err;
  }
  await probe.endSession();
  return model.startSession();
}

/**
 * Runs `work` inside a transaction, opening its own session when the caller has none.
 *
 * Phase 4 needs both shapes: `OrdersService` drives a transaction so that a status claim and
 * the inventory work it triggers commit together (spec §7.2 rule 4 - "reservation and order
 * status transition must be atomic"), while an internal caller such as the diagnostics
 * path can ask for a self-contained transaction.
 *
 * The session is always ended, including on failure, so a thrown error cannot leak a
 * session back into the connection pool.
 */
export async function withOptionalSession<T>(
  model: Model<any>,
  logger: LoggerService,
  existing: ClientSession | null | undefined,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  if (existing) return work(existing);
  const session = await openTransactionSession(model, logger);
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}