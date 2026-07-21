import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
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
    if (!user) throw new AppException(AppErrorCode.USER_NOT_FOUND);
    return this.sanitizeUser(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new AppException(AppErrorCode.USER_NOT_FOUND);

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
        throw new AppException(AppErrorCode.USER_EMAIL_ALREADY_EXISTS);
      }
      updateData.email = normalizedEmail;
    }

    if (dto.phoneNumber !== undefined) {
      const normalizedPhone = dto.phoneNumber.trim();
      const existingPhone = await this.userModel.findOne({
        phoneNumber: normalizedPhone,
        _id: { $ne: userId },
      }).exec();
      if (existingPhone) {
        throw new AppException(AppErrorCode.USER_PHONE_ALREADY_EXISTS);
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

    if (!updated) throw new AppException(AppErrorCode.USER_NOT_FOUND);
    return this.sanitizeUser(updated);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new AppException(AppErrorCode.USER_PASSWORDS_DO_NOT_MATCH);
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new AppException(AppErrorCode.USER_NOT_FOUND);

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isMatch) {
      throw new AppException(AppErrorCode.USER_CURRENT_PASSWORD_INCORRECT);
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
      createdAt: (user as any).createdAt,
      savedProductIds: (user.savedProductIds || []).map((id) => id.toString()),
    };
  }
}
