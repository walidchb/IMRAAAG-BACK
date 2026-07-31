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
    
    // Resolve User model
    const userModel = app.get<Model<User>>(getModelToken(User.name));
    
    // Check if admin already exists
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@imraaah.com';
    const existingAdmin = await userModel.findOne({ email: adminEmail });
    
    if (existingAdmin) {
      console.log('Admin user already exists. Skipping creation.');
    } else {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin123!', 10);
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
    console.error('Seeding failed:', error);
  } finally {
    await app.close();
  }
}

bootstrap();
