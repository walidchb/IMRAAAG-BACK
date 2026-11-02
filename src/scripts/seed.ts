import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../modules/users/schemas/user.schema';
import { Role } from '../common/constants/roles.enum';
import * as bcrypt from 'bcrypt';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  try {
    console.log('Seeding database...');

    // H14: never create a known-credential admin. Running this against production without
    // explicit env vars used to seed admin@imraaah.com / Admin123!, which is a public login.
    const isProduction = process.env.NODE_ENV === 'production';
    const configuredEmail = process.env.ADMIN_EMAIL?.trim();
    const configuredPassword = process.env.ADMIN_PASSWORD;

    if (isProduction && (!configuredEmail || !configuredPassword)) {
      throw new Error(
        'Refusing to seed in production without explicit ADMIN_EMAIL and ADMIN_PASSWORD. Set both to strong values first.',
      );
    }
    if (configuredPassword && configuredPassword.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    }

    // Resolve User model
    const userModel = app.get<Model<User>>(getModelToken(User.name));
    
    // Check if admin already exists
    const adminEmail = configuredEmail || 'admin@imraaah.com';
    const existingAdmin = await userModel.findOne({ email: adminEmail });
    
    if (existingAdmin) {
      console.log('Admin user already exists. Skipping creation.');
    } else {
      const hashedPassword = await bcrypt.hash(configuredPassword || 'Admin123!', 10);
      const newAdmin = new userModel({
        email: adminEmail,
        password: hashedPassword,
        fullName: 'System Admin',
        role: Role.ADMIN,
        isActive: true,
      });
      await newAdmin.save();
      console.log('Admin user created successfully!');
    }
  } catch (error) {
    console.error('Seeding failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

bootstrap();
