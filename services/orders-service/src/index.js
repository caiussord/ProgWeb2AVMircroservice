import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { PrismaClient } from '@prisma/client';
import { createChannel } from './amqp.js';
import { ROUTING_KEYS } from '../common/events.js';

const app = express();
app.use(express.json());
const prisma = new PrismaClient();
app.use(morgan('dev'));

const PORT = process.env.PORT || 3002;
const USERS_BASE_URL = process.env.USERS_BASE_URL || 'http://localhost:3001';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 2000);
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'app.topic';
const QUEUE = process.env.QUEUE || 'orders.q';
const ROUTING_KEY_USER_CREATED = process.env.ROUTING_KEY_USER_CREATED || ROUTING_KEYS.USER_CREATED;



let amqp = null;
(async () => {
  try {
    amqp = await createChannel(RABBITMQ_URL, EXCHANGE);
    console.log('[orders] AMQP connected');

    // Bind de fila para consumir eventos user.created
    await amqp.ch.assertQueue(QUEUE, { durable: true });
    await amqp.ch.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY_USER_CREATED);

    amqp.ch.consume(QUEUE, msg => {
      if (!msg) return;
      try {
        const user = JSON.parse(msg.content.toString());
        // idempotência simples: atualiza/define
        userCache.set(user.id, user);
        console.log('[orders] consumed event user.created -> cached', user.id);
        amqp.ch.ack(msg);
      } catch (err) {
        console.error('[orders] consume error:', err.message);
        amqp.ch.nack(msg, false, false); // descarta em caso de erro de parsing (aula: discutir DLQ)
      }
    });
  } catch (err) {
    console.error('[orders] AMQP connection failed:', err.message);
  }
})();

app.get('/health', (req, res) => res.json({ ok: true, service: 'orders' }));

app.get('/', async (req, res) => {
  const ordersFromDb = await prisma.order.findMany();
  const orders = ordersFromDb.map(order => ({
    ...order,
    items: JSON.parse(order.items),
  }));
  res.json(orders);
});


async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

app.post('/', async (req, res) => {
  const { userId, items, total } = req.body || {};
  if (!userId || !Array.isArray(items) || typeof total !== 'number') {
  const order = await prisma.order.create({
    data: {
      userId,
      items, //Itens -> Json
      total,
    },
  }); return res.status(400).json({ error: 'userId, items[], total<number> são obrigatórios' });
  }
  // 1) Validação síncrona (HTTP) no Users Service
  try {
    const resp = await fetchWithTimeout(`${USERS_BASE_URL}/${userId}`, HTTP_TIMEOUT_MS);
    if (!resp.ok) return res.status(400).json({ error: 'usuário inválido' });
  } catch (err) {
    console.warn('[orders] users-service timeout/failure, tentando cache...', err.message);
    // fallback: usar cache populado por eventos (assíncrono)
    if (!userCache.has(userId)) {
      return res.status(503).json({ error: 'users-service indisponível e usuário não encontrado no cache' });
    }
  }

    const orderData = await prisma.order.create({
    data: {
      userId,
      items: JSON.stringify(items), //String -> Json
      total,
    },
  });

  const order = {
    ...orderData,
    items: JSON.parse(orderData.items), // Conversao para resposta cliente
  };


  // (Opcional) publicar evento order.created
  try {
    if (amqp?.ch) {
      amqp.ch.publish(EXCHANGE, ROUTING_KEYS.ORDER_CREATED, Buffer.from(JSON.stringify(order)), { persistent: true });
      console.log('[orders] published event:', ROUTING_KEYS.ORDER_CREATED, order.id);
    }
  } catch (err) {
    console.error('[orders] publish error:', err.message);
  }

  res.status(201).json(order);
});

//Order cancel
app.patch('/:id/cancel', async (req, res) => {
  try {
    const cancelledOrderData = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'cancelled' },
    });

    const cancelledOrder = {
        ...cancelledOrderData,
        items: JSON.parse(cancelledOrderData.items) // Conversao para resposta cliente
    };


  // Publish event order
  try {
    if (amqp?.ch) {
      const payload = Buffer.from(JSON.stringify(cancelledOrder));
      amqp.ch.publish(EXCHANGE, ROUTING_KEYS.ORDER_CANCELLED, payload, { persistent: true });
      console.log('[orders] published event:', ROUTING_KEYS.ORDER_CANCELLED, cancelledOrder.id);
    }
  } catch (err) {
    console.error('[orders] publish error:', err.message);
  }
  res.json(cancelledOrder);
  } catch (error) {
    res.status(404).json({ error: 'order not found' });
  }
});


app.listen(PORT, () => {
  console.log(`[orders] listening on http://localhost:${PORT}`);
});
