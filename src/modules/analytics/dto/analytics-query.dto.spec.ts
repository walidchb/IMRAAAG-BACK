import { validate } from 'class-validator';
import { AnalyticsRangeQueryDto } from './analytics-query.dto';

/**
 * Shared analytics query contract (roadmap Phase 2).
 *
 * The DTO is what the global ValidationPipe runs every `/analytics/*` read through: a typo in a
 * preset/channel/bucket already 400s (Phase 1). Phase 2 added `metric`, pinned to the trend-metric
 * dictionary so a mistyped series can't silently become the default.
 */
describe('AnalyticsRangeQueryDto', () => {
  it('accepts every declared trend metric (sales default, orders, units)', async () => {
    for (const metric of ['sales', 'orders', 'units']) {
      const dto = new AnalyticsRangeQueryDto();
      dto.metric = metric;
      await expect(validate(dto)).resolves.toEqual([]);
    }
  });

  it('rejects a trend metric outside the dictionary', async () => {
    const dto = new AnalyticsRangeQueryDto();
    dto.metric = 'profit';
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('metric');
  });

  it('remains valid without a metric (defaults to sales server-side)', async () => {
    await expect(validate(new AnalyticsRangeQueryDto())).resolves.toEqual([]);
  });

  it('still rejects unknown presets alongside a valid metric', async () => {
    const dto = new AnalyticsRangeQueryDto();
    dto.metric = 'sales';
    dto.preset = 'quarter';
    const errors = await validate(dto);
    const properties = errors.map((e) => e.property);
    expect(properties).toEqual(['preset']);
  });
});