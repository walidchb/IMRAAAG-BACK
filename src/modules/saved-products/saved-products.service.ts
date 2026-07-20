import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SavedProduct, SavedProductDocument } from './schemas/saved-product.schema';
import { User, UserDocument } from '../users/schemas/user.schema';

@Injectable()
export class SavedProductsService {
  constructor(
    @InjectModel(SavedProduct.name) private savedProductModel: Model<SavedProductDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  async findAll(userId: string) {
    return this.savedProductModel
      .find({ userId: new Types.ObjectId(userId) })
      .populate('productId')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async toggle(userId: string, productId: string) {
    const objectUserId = new Types.ObjectId(userId);
    const objectProductId = new Types.ObjectId(productId);

    const existing = await this.savedProductModel.findOne({
      userId: objectUserId,
      productId: objectProductId,
    });

    if (existing) {
      await this.savedProductModel.deleteOne({ _id: existing._id });
      await this.userModel.findByIdAndUpdate(userId, {
        $pull: { savedProductIds: objectProductId },
      });
      return { saved: false, productId };
    }

    await this.savedProductModel.create({
      userId: objectUserId,
      productId: objectProductId,
    });
    await this.userModel.findByIdAndUpdate(userId, {
      $addToSet: { savedProductIds: objectProductId },
    });
    return { saved: true, productId };
  }
}
