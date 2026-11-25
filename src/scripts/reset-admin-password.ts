import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../app.module';
import { Admin, AdminDocument } from '../modules/admin/schemas/admin.schema';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REGEX,
  isCommonPassword,
} from '../common/constants/password.const';

interface Args {
  email?: string;
  password?: string;
  dryRun: boolean;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inline] = token.split('=');
    const next = () => inline ?? argv[++i];
    switch (flag) {
      case '--email':
        args.email = next();
        break;
      case '--password':
        args.password = next();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--confirm':
        args.confirm = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function passwordError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`;
  if (!PASSWORD_REGEX.test(password))
    return 'Password must include at least one letter and one number.';
  if (isCommonPassword(password)) return 'This password is too common. Choose another one.';
  return null;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const isProduction = process.env.NODE_ENV === 'production';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
    abortOnError: false,
  });

  try {
    const adminModel = app.get<Model<AdminDocument>>(getModelToken(Admin.name));
    const config = app.get(ConfigService);
    console.log(`Target database: ${adminModel.db.host}/${adminModel.db.name}`);

    const email = (args.email || process.env.ADMIN_BOOTSTRAP_EMAIL || '')
      .trim()
      .toLowerCase();
    const password = args.password || process.env.ADMIN_BOOTSTRAP_PASSWORD || '';

    if (!email || !password) {
      console.error(
        'ERROR: Provide --email and --password, or set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD.',
      );
      return 1;
    }
    const pwdError = passwordError(password);
    if (pwdError) {
      console.error(`ERROR: ${pwdError}`);
      return 1;
    }

    const admin = await adminModel.findOne({ email }).select('_id email').lean().exec();
    if (!admin) {
      console.error(`ERROR: No admin found for ${email}.`);
      return 1;
    }

    if (args.dryRun) {
      console.log(`[dry-run] Would reset the password for ${email}. Nothing written.`);
      return 0;
    }
    if (isProduction && !args.confirm) {
      console.error('ERROR: Refusing to reset a password in production without --confirm.');
      return 1;
    }

    const rounds = config.get<number>('adminAuth.bcryptRounds') ?? 12;
    const passwordHash = await bcrypt.hash(password, rounds);
    await adminModel.updateOne(
      { _id: admin._id },
      {
        $set: {
          passwordHash,
          passwordChangedAt: new Date(),
          refreshTokenHash: null,
          refreshTokenExpiresAt: null,
        },
        $inc: { tokenVersion: 1 },
      },
    );

    console.log(`Password reset for admin id=${admin._id} email=${admin.email}. All sessions revoked.`);
    return 0;
  } catch (error) {
    console.error('Reset failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await app.close();
  }
}

run().then((code) => {
  process.exitCode = code;
});
