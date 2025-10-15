import express from 'express';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client';
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../common/events.js';

export const app = express();
const prisma = new PrismaClient();
app.use(express.json());
app.use(morgan('dev'));

const PORT = process.env.PORT || 3001;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';


let amqp = null;
if (!process.env.JEST_WORKER_ID) {
  (async () => {
    try {
      amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
      console.log('[users] AMQP connected');
    } catch (err) {
      console.error('[users] AMQP connection failed:', err.message);
    }
  })();
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'users' }));

app.get('/', async (req, res) => {
  const users = await prisma.user.findMany();
  res.json(users);
});

app.post('/', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  try {
    const user = await prisma.user.create({
      data: { name, email },
    });

  // Publish event
  try {
    if (amqp?.ch) {
      const payload = Buffer.from(JSON.stringify(user));
      amqp.ch.publish(EXCHANGE, ROUTING_KEYS.USER_CREATED, payload, { persistent: true });
      console.log('[users] published event:', ROUTING_KEYS.USER_CREATED, user);
    }
  } catch (err) {
    console.error('[users] publish error:', err.message);
  }

  res.status(201).json(user);
}catch (error) {
    // erro de e-mail duplicado
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'email ja existe' });
    }
    res.status(500).json({ error: 'something went wrong' });
  }
});

app.get('/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
  });
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
});

app.put('/:id', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.params.id },
      data: { name, email },
    });

   
   // Publish event update
  try {
    if (amqp?.ch) {
      const payload = Buffer.from(JSON.stringify(updatedUser));
      amqp.ch.publish(EXCHANGE, ROUTING_KEYS.USER_UPDATED, payload, { persistent: true });
      console.log('[users] published event:', ROUTING_KEYS.USER_UPDATED, updatedUser);
    }
  } catch (err) {
    console.error('[users] publish error:', err.message);
  }

  res.json(updatedUser);
} catch (error) {
    // erro de utilizador não encontrado ou e-mail duplicado
    res.status(404).json({ error: 'user not found or invalid data' });
  }
});


if (!process.env.JEST_WORKER_ID && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[users] listening on http://localhost:${PORT}`);
  });
}