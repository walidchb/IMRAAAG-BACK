import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../app.module';
import { Admin, AdminDocument } from '../modules/admin/schemas/admin.schema';
import { AdminStatus } from '../common/constants/admin-status.enum';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REGEX,
  isCommonPassword,
} from '../common/constants/password.const';

interface Args {
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  dryRun: boolean;
  confirm: boolean;
  ifMissing: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, confirm: false, ifMissing: false };
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
      case '--firstName':
      case '--first-name':
        args.firstName = next();
        break;
      case '--lastName':
      case '--last-name':
        args.lastName = next();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--confirm':
        args.confirm = true;
        break;
      case '--if-missing':
        args.ifMissing = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

function deriveName(email: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim().slice(0, 80);
  const local = email.split('@')[0] || 'Admin';
  return (local.charAt(0).toUpperCase() + local.slice(1)).slice(0, 80);
}

function logTarget(model: Model<AdminDocument>) {
  const connection = model.db;
  // Never print a credential — the connection URI may contain one, so only host + database.
  console.log(`Target database: ${connection.host}/${connection.name}`);
}

function refusal(message: string): number {
  console.error(`ERROR: ${message}`);
  return 1;
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
    logTarget(adminModel);

    const email = (args.email || process.env.ADMIN_BOOTSTRAP_EMAIL || '')
      .trim()
      .toLowerCase();
    const password = args.password || process.env.ADMIN_BOOTSTRAP_PASSWORD || '';

    if (!email || !password) {
      return refusal(
        'Provide --email and --password, or set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD.',
      );
    }
    if (!isValidEmail(email)) return refusal('The target email is not a valid address.');
    const pwdError = passwordError(password);
    if (pwdError) return refusal(pwdError);

    const existingCount = await adminModel.countDocuments({});
    if (existingCount > 0) {
      if (args.ifMissing) {
        const existing = await adminModel
          .findOne({ email })
          .select('_id email')
          .lean()
          .exec();
        if (existing) {
          console.log(`Admin already exists (id=${existing._id}, email=${existing.email}); no changes.`);
          return 0;
        }
      }
      return refusal(
        'Admin accounts already exist. Create additional admins in the Admin Panel.',
      );
    }

    const firstName = deriveName(email, args.firstName);
    const lastName = deriveName(email, args.lastName ?? 'Admin');

    if (args.dryRun) {
      console.log(
        `[dry-run] Would create the first admin: ${firstName} ${lastName} <${email}>. Nothing written.`,
      );
      return 0;
    }
    if (isProduction && !args.confirm) {
      return refusal('Refusing to bootstrap an admin in production without --confirm.');
    }

    const rounds = config.get<number>('adminAuth.bcryptRounds') ?? 12;
    const passwordHash = await bcrypt.hash(password, rounds);

    try {
      const created = await adminModel.create({
        firstName,
        lastName,
        email,
        passwordHash,
        status: AdminStatus.ACTIVE,
      });
      console.log(`Created admin id=${created._id} email=${created.email}`);
      return 0;
    } catch (error: any) {
      if (error?.code === 11000) {
        return refusal('An admin with that email already exists.');
      }
      throw error;
    }
  } catch (error) {
    console.error('Bootstrap failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await app.close();
  }
}

run().then((code) => {
  process.exitCode = code;
});
