import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { GenerateOrderLabelsDto } from './generate-order-labels.dto';

const ids = (count: number) =>
  Array.from({ length: count }, () => new Types.ObjectId().toString());

function build(overrides: Record<string, unknown> = {}) {
  return plainToInstance(GenerateOrderLabelsDto, {
    ids: ids(1),
    format: '10x15',
    grouping: 'combined',
    ...overrides,
  });
}

async function codes(dto: GenerateOrderLabelsDto): Promise<string[]> {
  const errors = await validate(dto);
  return errors.flatMap((error) =>
    Object.keys(error.constraints ?? {}).map((key) => `${error.property}:${key}`),
  );
}

describe('GenerateOrderLabelsDto', () => {
  it('accepts 1-100 Mongo ids with a known format and grouping', async () => {
    await expect(validate(build())).resolves.toEqual([]);
    await expect(validate(build({ ids: ids(100) }))).resolves.toEqual([]);
  });

  it('rejects an empty id list', async () => {
    expect(await codes(build({ ids: [] }))).toContain('ids:arrayMinSize');
  });

  it('rejects more than 100 orders', async () => {
    expect(await codes(build({ ids: ids(101) }))).toContain('ids:arrayMaxSize');
  });

  it('accepts duplicate ids (the service deduplicates) and rejects malformed ids', async () => {
    const id = new Types.ObjectId().toString();
    await expect(validate(build({ ids: [id, id] }))).resolves.toEqual([]);
    expect(await codes(build({ ids: ['not-an-id'] }))).toContain('ids:isMongoId');
  });

  it('rejects an unknown format or grouping', async () => {
    expect(await codes(build({ format: 'a5' }))).toContain('format:isIn');
    expect(await codes(build({ grouping: 'per_order' }))).toContain('grouping:isIn');
  });
});
