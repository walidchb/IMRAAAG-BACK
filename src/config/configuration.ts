export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  database: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah',
  },
  jwt: {
    secret: process.env.JWT_SECRET || '***REMOVED***',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.EMAIL_FROM || 'noreply@imraaah.ma',
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',
  environment: process.env.NODE_ENV || 'development',
  r2: {
    endpoint: process.env.R2_ENDPOINT || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || 'imraaah',
    publicUrl: process.env.R2_PUBLIC_URL || '',
  },
});
