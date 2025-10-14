import request from 'supertest';
import { app, prisma } from '../src/index.js';

beforeAll(async () => {
  // nothing
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.order.deleteMany();
});

describe('orders-service', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'orders' });
  });

  test('POST / invalid payload -> 400', async () => {
    const res = await request(app)
      .post('/')
      .send({ userId: '', items: 'not-array', total: 'NaN' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
  });

  test('POST / valid payload -> 201', async () => {
    // In test env we skip calling Users Service; assume user exists
    const res = await request(app)
      .post('/')
      .send({ userId: 'u_1', items: [{ sku: 'X', qty: 1 }], total: 10.5 })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test('GET / lists orders', async () => {
    await prisma.order.create({ data: { userId: 'u_1', items: JSON.stringify([{sku:'A', qty:2}]), total: 99 } });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('items');
    expect(Array.isArray(res.body[0].items)).toBe(true);
  });

  test('PATCH /:id/cancel cancels order', async () => {
    const created = await prisma.order.create({ data: { userId: 'u_2', items: JSON.stringify([{sku:'B', qty:1}]), total: 50 } });
    const res = await request(app).patch(`/${created.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
