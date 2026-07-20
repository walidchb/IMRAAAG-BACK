import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from '../users/schemas/user.schema';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class ProfileService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  async getProfile(userId: string) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');
    return this.sanitizeUser(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    const updateData: Record<string, unknown> = {};

    if (dto.fullName !== undefined) {
      updateData.fullName = dto.fullName.trim();
      updateData.firstName = dto.fullName.trim();
    }

    if (dto.email !== undefined) {
      const normalizedEmail = dto.email.toLowerCase().trim();
      const existingEmail = await this.userModel.findOne({
        email: normalizedEmail,
        _id: { $ne: userId },
      }).exec();
      if (existingEmail) {
        throw new ConflictException('Email is already in use');
      }
      updateData.email = normalizedEmail;
      updateData.isEmailVerified = false;
    }

    if (dto.phoneNumber !== undefined) {
      const normalizedPhone = dto.phoneNumber.trim();
      const existingPhone = await this.userModel.findOne({
        phoneNumber: normalizedPhone,
        _id: { $ne: userId },
      }).exec();
      if (existingPhone) {
        throw new ConflictException('Phone number is already in use');
      }
      updateData.phoneNumber = normalizedPhone;
    }

    if (dto.gender !== undefined) {
      updateData.gender = dto.gender;
    }

    if (Object.keys(updateData).length === 0) {
      return this.sanitizeUser(user);
    }

    const updated = await this.userModel
      .findByIdAndUpdate(userId, { $set: updateData }, { returnDocument: 'after' })
      .exec();

    if (!updated) throw new NotFoundException('User not found');
    return this.sanitizeUser(updated);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.userModel.findByIdAndUpdate(userId, { password: hashedPassword }).exec();

    return { message: 'Password updated successfully' };
  }

  private sanitizeUser(user: UserDocument) {
    return {
      id: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      role: user.role,
      gender: user.gender || null,
      profileImage: user.profileImage || null,
      isEmailVerified: user.isEmailVerified,
      createdAt: (user as any).createdAt,
      savedProductIds: (user.savedProductIds || []).map((id) => id.toString()),
    };
  }
}
