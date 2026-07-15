import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Wilaya, WilayaDocument } from './schemas/wilaya.schema';
import { Commune, CommuneDocument } from './schemas/commune.schema';

@Injectable()
export class TerritoriesService {
  private readonly logger = new Logger(TerritoriesService.name);

  constructor(
    @InjectModel(Wilaya.name) private wilayaModel: Model<WilayaDocument>,
    @InjectModel(Commune.name) private communeModel: Model<CommuneDocument>,
  ) {}

  async getWilayas() {
    const wilayas = await this.wilayaModel.find().exec();
    return wilayas.sort((a, b) => parseInt(a.code, 10) - parseInt(b.code, 10));
  }

  async getCommunes(wilayaCode?: string) {
    const filter = wilayaCode ? { wilaya_code: wilayaCode } : {};
    return this.communeModel.find(filter).sort({ name: 1 }).exec();
  }

  async updateWilayaUuid(code: string, zrexpress_uuid?: string, yalidine_uuid?: string, ecomdelivery_uuid?: string) {
    const update: Record<string, string> = {};
    if (zrexpress_uuid !== undefined) update.zrexpress_uuid = zrexpress_uuid;
    if (yalidine_uuid !== undefined) update.yalidine_uuid = yalidine_uuid;
    if (ecomdelivery_uuid !== undefined) update.ecomdelivery_uuid = ecomdelivery_uuid;
    return this.wilayaModel.findOneAndUpdate({ code }, { $set: update }, { new: true }).exec();
  }

  async updateCommuneUuid(post_code: string, zrexpress_uuid?: string, yalidine_uuid?: string, ecomdelivery_uuid?: string) {
    const update: Record<string, string> = {};
    if (zrexpress_uuid !== undefined) update.zrexpress_uuid = zrexpress_uuid;
    if (yalidine_uuid !== undefined) update.yalidine_uuid = yalidine_uuid;
    if (ecomdelivery_uuid !== undefined) update.ecomdelivery_uuid = ecomdelivery_uuid;
    return this.communeModel.findOneAndUpdate({ post_code }, { $set: update }, { new: true }).exec();
  }

  async migrateNewWilayas(): Promise<{ moved: number }> {
    const MIGRATION_MAP: Record<string, string> = {
      // 49 El M'ghair (split from El Oued 39)
      '39027': '49', '39028': '49', '39029': '49', '39030': '49',
      // 50 El Menia (split from Ghardaïa 47)
      '47002': '50',
      // 51 Ouled Djellal (split from Biskra 7)
      '07005': '51', '07006': '51', '07008': '51', '07009': '51', '07010': '51',
      // 52 Bordj Baji Mokhtar (split from Adrar 1)
      '01025': '52', '01028': '52',
      // 53 Béni Abbès (split from Béchar 8)
      '08007': '53', '08003': '53', '08018': '53', '08019': '53', '08020': '53', '08021': '53',
      '08008': '53', '08009': '53', '08010': '53', '08011': '53', '08012': '53', '08013': '53', '08014': '53',
      // 54 Timimoun (split from Adrar 1)
      '01009': '54', '01003': '54', '01016': '54', '01017': '54', '01018': '54', '01020': '54', '01023': '54', '01024': '54', '01026': '54', '01027': '54',
      // 55 Touggourt (split from Ouargla 30)
      '30013': '55', '30006': '55', '30007': '55', '30008': '55', '30009': '55', '30010': '55', '30011': '55', '30012': '55',
      '30014': '55', '30015': '55', '30016': '55', '30017': '55', '30018': '55', '30019': '55', '30020': '55',
      // 56 Djanet (split from Illizi 33)
      '33002': '56',
      // 57 In Salah (split from Tamanrasset 11)
      '11008': '57', '11003': '57', '11005': '57', '11006': '57', '11009': '57',
      // 58 In Guezzam (split from Tamanrasset 11)
      '11004': '58', '11007': '58',
    };

    let moved = 0;
    for (const [postCode, newWilaya] of Object.entries(MIGRATION_MAP)) {
      const result = await this.communeModel.updateOne(
        { post_code: postCode },
        { $set: { wilaya_code: newWilaya } },
      ).exec();
      if (result.modifiedCount > 0) moved++;
    }

    this.logger.log(`Migrated ${moved} communes to new wilayas`);
    return { moved };
  }

  async seed(): Promise<{ wilayas: number; communes: number }> {
    const wilayaPath = path.resolve(__dirname, '../../../Wilaya_Of_Algeria.json');
    const communePath = path.resolve(__dirname, '../../../Commune_Of_Algeria.json');

    const rawWilayas = JSON.parse(fs.readFileSync(wilayaPath, 'utf-8')) as Array<{
      id: string; code: string; name: string; ar_name: string;
      longitude: string; latitude: string;
    }>;

    const rawCommunes = JSON.parse(fs.readFileSync(communePath, 'utf-8')) as Array<{
      id: string; post_code: string; name: string; wilaya_id: string;
      ar_name: string; longitude: string; latitude: string;
    }>;

    const wilayaCodeMap = new Map(rawWilayas.map(w => [w.id, w.code]));

    const wilayas = rawWilayas.map(w => ({
      code: w.code,
      name: w.name,
      ar_name: w.ar_name,
      longitude: w.longitude,
      latitude: w.latitude,
    }));

    const communes = rawCommunes.map(c => ({
      post_code: c.post_code,
      name: c.name,
      ar_name: c.ar_name,
      longitude: c.longitude,
      latitude: c.latitude,
      wilaya_code: wilayaCodeMap.get(c.wilaya_id) || c.wilaya_id,
    }));

    await this.wilayaModel.deleteMany({});
    await this.communeModel.deleteMany({});

    const insertedWilayas = await this.wilayaModel.insertMany(wilayas);
    const insertedCommunes = await this.communeModel.insertMany(communes);

    this.logger.log(`Seeded ${insertedWilayas.length} wilayas and ${insertedCommunes.length} communes`);

    return { wilayas: insertedWilayas.length, communes: insertedCommunes.length };
  }
}
