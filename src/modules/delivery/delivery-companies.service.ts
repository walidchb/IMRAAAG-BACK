import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeliveryCompany, DeliveryCompanyDocument } from './schemas/delivery-company.schema';

@Injectable()
export class DeliveryCompaniesService {
  constructor(
    @InjectModel(DeliveryCompany.name)
    private companyModel: Model<DeliveryCompanyDocument>,
  ) {}

  async getAll(): Promise<DeliveryCompany[]> {
    return this.companyModel.find().sort({ slug: 1 }).exec();
  }

  async getBySlug(slug: string): Promise<DeliveryCompany | null> {
    return this.companyModel.findOne({ slug }).exec();
  }
}
