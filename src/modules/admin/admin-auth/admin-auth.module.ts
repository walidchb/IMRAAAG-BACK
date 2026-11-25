import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Admin, AdminSchema } from '../schemas/admin.schema';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminJwtStrategy } from './admin-jwt.strategy';
import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';
import { AdminOriginGuard } from './admin-origin.guard';
import {
  ADMIN_TOKEN_AUDIENCE,
  ADMIN_TOKEN_ISSUER,
  resolveAdminJwtSecret,
} from './admin-session.util';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Admin.name, schema: AdminSchema }]),
    // No `defaultStrategy`: the seller AuthModule already registers 'jwt'. Admin routes use
    // the explicit 'admin-jwt' strategy only.
    PassportModule.register({}),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: resolveAdminJwtSecret(configService),
        signOptions: {
          expiresIn: (configService.get<string>('adminAuth.accessTtl') || '15m') as any,
          issuer: ADMIN_TOKEN_ISSUER,
          audience: ADMIN_TOKEN_AUDIENCE,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminJwtStrategy, AdminJwtAuthGuard, AdminOriginGuard],
  exports: [
    AdminAuthService,
    AdminJwtStrategy,
    AdminJwtAuthGuard,
    AdminOriginGuard,
    JwtModule,
    MongooseModule,
  ],
})
export class AdminAuthModule {}
