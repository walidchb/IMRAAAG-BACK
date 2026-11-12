import {
  Controller,
  Post,
  Delete,
  Body,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { UploadService } from './upload.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StoresService } from '../stores/stores.service';
import { StorePermission, hasStorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { IMAGE_CONFIG } from './image.config';

@ApiTags('Upload')
@Controller('upload')
@Roles(Role.VENDOR, Role.ADMIN)
@Throttle({ default: { limit: 20, ttl: 60000 } })
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly storesService: StoresService,
  ) {}

  /**
   * The tenant namespace an upload belongs to. Resolved from the session only - never from a
   * request field - so a vendor cannot write (or later delete) inside another store's prefix.
   * Admins get their own `admin/<id>` prefix because they have no store.
   */
  private async scopeFor(req: any): Promise<string> {
    const user = req.user;
    if (user?.role === Role.ADMIN) {
      return `admin/${String(user.id ?? user.email)}`;
    }
    const store = await this.storesService.findByMemberIdOrThrow(String(user.id));
    return String(store._id);
  }

  @Post('product-image')
  @RequirePermissions(StorePermission.PRODUCTS_UPDATE)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a single product image' })
  @ApiConsumes('multipart/form-data')
  async uploadProductImage(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadProductImage(file, await this.scopeFor(req));
  }

  @Post('product-images')
  @RequirePermissions(StorePermission.PRODUCTS_UPDATE)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FilesInterceptor('files', 10, { limits: { fileSize: IMAGE_CONFIG.maxFileSize, files: 10 } }),
  )
  @ApiOperation({ summary: 'Upload multiple product images (max 10)' })
  @ApiConsumes('multipart/form-data')
  async uploadProductImages(@UploadedFiles() files: Express.Multer.File[], @Req() req: any) {
    if (!files || files.length === 0)
      throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    if (files.length > 10)
      throw new AppException(AppErrorCode.UPLOAD_MAX_FILES_EXCEEDED);
    const results = await this.uploadService.uploadProductImages(files, await this.scopeFor(req));
    return { images: results };
  }

  @Post('store-logo')
  @RequirePermissions(StorePermission.STORE_UPDATE)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a store logo' })
  @ApiConsumes('multipart/form-data')
  async uploadStoreLogo(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadStoreLogo(file, await this.scopeFor(req));
  }

  @Post('store-cover')
  @RequirePermissions(StorePermission.STORE_UPDATE)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a store cover image' })
  @ApiConsumes('multipart/form-data')
  async uploadStoreCover(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadStoreCover(file, await this.scopeFor(req));
  }

  @Post('category-image')
  @RequirePermissions(StorePermission.PRODUCTS_CATEGORIES_MANAGE)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a category image' })
  @ApiConsumes('multipart/form-data')
  async uploadCategoryImage(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadCategoryImage(file, await this.scopeFor(req));
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an uploaded image by key' })
  async deleteFile(@Req() req: any, @Body('key') key: string) {
    if (!key) throw new AppException(AppErrorCode.UPLOAD_NO_KEY_PROVIDED);
    this.assertAllowedKey(key, await this.scopeFor(req));
    await this.assertDeletePermission(req, key);
    await this.uploadService.deleteFile(key);
    return { message: 'File deleted' };
  }

  /**
   * A delete carries no static capability: the key's folder namespaces it. Product images need
   * `products.update`, category images `products.categories.manage`, store branding
   * `store.update`; profile avatars are self-service and need no store permission.
   */
  private async assertDeletePermission(req: any, key: string): Promise<void> {
    const user = req.user;
    if (user?.role === Role.ADMIN) return;

    let permission: string | null = null;
    if (key.includes('/products/')) permission = StorePermission.PRODUCTS_UPDATE;
    else if (key.includes('/categories/')) permission = StorePermission.PRODUCTS_CATEGORIES_MANAGE;
    else if (key.includes('/stores/')) permission = StorePermission.STORE_UPDATE;
    if (!permission) return;

    const access = await this.storesService.resolvePermissionsForUser(String(user?.id ?? ''));
    if (!hasStorePermission(access.permissions, permission)) {
      throw new AppException(AppErrorCode.AUTH_INSUFFICIENT_PERMISSIONS, { permission });
    }
  }

  /**
   * A delete is allowed only for an object inside the caller's own namespace. Two checks
   * apply: the key must be shaped exactly like one of our uploads, and its
   * `store/<scope>/` prefix must be the caller's own (H7). Before this, any authenticated
   * vendor could delete another vendor's image just by knowing its key. Keys uploaded before
   * namespacing have no owner prefix and are therefore refused here; the server-side cleanup
   * paths (product update, store update) go through `UploadService` directly and still remove
   * legacy objects.
   */
  private assertAllowedKey(key: string, scope: string): void {
    const folders = Object.values(IMAGE_CONFIG.folders).join('|');
    const escapedScope = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const allowedShape = new RegExp(
      `^store/${escapedScope}/(${folders})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z]+)?\\.webp$`,
    );
    if (!allowedShape.test(key)) {
      throw new AppException(AppErrorCode.UPLOAD_KEY_FORBIDDEN, { key });
    }
  }
}
