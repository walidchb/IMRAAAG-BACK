import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Role } from '../../../common/constants/roles.enum';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop({ required: true, trim: true })
  fullName: string;

  @Prop({ type: String, enum: Role, default: Role.CUSTOMER })
  role: Role;

  @Prop()
  profileImage: string;

  @Prop({ trim: true })
  phoneNumber: string;

  @Prop({ type: String, enum: ['Male', 'Female'] })
  gender: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  lastLogin: Date;

  @Prop()
  refreshToken: string;

  @Prop()
  refreshTokenExpiresAt: Date;

  @Prop({
    type: {
      fullName: String,
      phoneNumber: String,
      addressLine1: String,
      addressLine2: String,
      city: String,
      state: String,
      postalCode: String,
      country: { type: String, default: 'Algeria' }
    }
  })
  address: {
    fullName?: string;
    phoneNumber?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Product' }] })
  savedProductIds: Types.ObjectId[];
}

export const UserSchema = SchemaFactory.createForClass(User);

// Indexes
UserSchema.index({ email: 1 });
UserSchema.index({ role: 1 });
UserSchema.index({ phoneNumber: 1 });
UserSchema.index(
  { phoneNumber: 1 },
  { unique: true, partialFilterExpression: { phoneNumber: { $exists: true, $nin: ['', null] } } }
);
UserSchema.index({ refreshToken: 1 });
UserSchema.index({ refreshTokenExpiresAt: 1 }, { expireAfterSeconds: 0 });
