import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { validateEnv, env } from './config/env';
import { logger } from './utils/logger';
import { generalLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { initSocketIO } from './socket';
import { startWorkers } from './workers';

// Routes
import authRoutes from './routes/auth';
import walletRoutes from './routes/wallet';
import paymentRoutes from './routes/payments';
import betRoutes from './routes/bets';
import affiliateRoutes from './routes/affiliates';
import adminRoutes from './routes/admin';
import simulationRoutes from './routes/simulation';
import fraudRoutes from './routes/fraud';
import matchRoutes from './routes/matches';
import teamLogoRoutes from './routes/teams';

validateEnv();

const app = express();
const server = http.createServer(app);

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware
app.use(compression() as express.RequestHandler);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use(generalLimiter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'xfamebet-api' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/bets', betRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/team-logo', teamLogoRoutes);
app.use('/api/affiliates', affiliateRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/simulation', simulationRoutes);
app.use('/api/fraud', fraudRoutes);

// 404 and error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Init Socket.IO
initSocketIO(server);

// Start background workers
startWorkers();

server.listen(env.PORT, () => {
  logger.info(`XfameBet API running on port ${env.PORT} [${env.NODE_ENV}]`);
});

export default app;
