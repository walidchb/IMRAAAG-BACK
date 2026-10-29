require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const { NestFactory } = require('@nestjs/core');
const { Logger } = require('@nestjs/common');

/**
 * Runs one carrier status cycle in-process and prints the summary.
 *
 * Diagnostic/manual-run helper. It drives the real poller, so it writes the same records a
 * scheduled cycle would; orders only advance on an in_transit / delivered / cancelled /
 * returned signal that the order state machine allows.
 *
 * node scripts/run-noest-cycle.js [companyId] [--debug]
 */
async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const companyId = args[0] || 'noest';
  const levels = ['error', 'warn', 'log'];
  if (process.argv.includes('--debug')) levels.push('debug');

  const app = await NestFactory.createApplicationContext(require('../dist/app.module').AppModule, {
    logger: levels,
  });
  const logger = new Logger(`run-${companyId}-cycle`);

  try {
    // Bootstrapping AppModule starts a `setTimeout(..., 0)` chain per enabled provider. This
    // helper wants exactly one explicit cycle, so stop the scheduler before those timers fire.
    const { DeliveryStatusScheduler } = require('../dist/modules/delivery/delivery-status/delivery-status.scheduler');
    app.get(DeliveryStatusScheduler).onModuleDestroy();

    const { DeliveryStatusService } = require('../dist/modules/delivery/delivery-status/delivery-status.service');
    const service = app.get(DeliveryStatusService);

    logger.log(`settingsFor('${companyId}') = ${JSON.stringify(service.settingsFor(companyId))}`);
    logger.log(
      `enabledProviders = ${service
        .enabledProviders()
        .map((profile) => profile.companyId)
        .join(', ')}`,
    );

    const summary = await service.runCycle({ companyId });
    logger.log(`SUMMARY ${JSON.stringify(summary)}`);
  } catch (error) {
    logger.error(`CYCLE FAILED: ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
