import mysql from 'mysql2/promise';
import { startMysql } from '../support/mysql-container';

/** Starts the throwaway MySQL (random port, cais-test-*) and seeds it. Returns the teardown. */
export default async function globalSetup(): Promise<() => void> {
  const db = await startMysql();
  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    multipleStatements: true,
  });
  await conn.query(`
    CREATE TABLE companies (id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, national_id CHAR(14) NULL);
    CREATE TABLE cards (id INT PRIMARY KEY, company_id INT NOT NULL, status VARCHAR(20) NOT NULL, created_at DATETIME NOT NULL);
    CREATE TABLE people (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50) NOT NULL, email VARCHAR(80), profile JSON);
    CREATE TABLE agent_items (id INT PRIMARY KEY, status VARCHAR(20) NOT NULL, owner VARCHAR(60) NOT NULL);
    INSERT INTO agent_items VALUES (1, 'active', 'ana@exemplo.com'), (2, 'active', 'bia@exemplo.com'), (3, 'active', 'caio@exemplo.com');
    CREATE TABLE agent_legacy (id INT PRIMARY KEY AUTO_INCREMENT, note VARCHAR(40)) ENGINE=MyISAM;
    INSERT INTO companies VALUES (1, 'Café Aurora Ltda', '12345678000190'), (2, 'Papelaria Horizonte', NULL), (3, 'Mercado Central', '98765432000110');
    INSERT INTO cards VALUES
      (4810, 1, 'active', '2026-10-01 09:12:44'), (4811, 1, 'active', '2026-10-02 11:03:10'),
      (4812, 1, 'active', '2026-10-04 15:40:02'), (4813, 2, 'active', '2026-10-05 08:00:00'),
      (4814, 3, 'pending', '2026-10-09 17:22:31'), (4815, 3, 'cancelled', '2026-10-10 10:10:10');
    CREATE TABLE grid_items (id INT PRIMARY KEY, name VARCHAR(60) NOT NULL, note VARCHAR(100) NULL, price DECIMAL(10,2) NOT NULL);
    INSERT INTO grid_items VALUES (1, 'Caneta', 'azul', 2.50), (2, 'Caderno', NULL, 18.90), (3, 'Lápis', 'HB', 1.20), (4, 'Borracha', 'branca', 0.90);
    INSERT INTO people (name, email, profile) VALUES
      ('Ana', 'ana@exemplo.com', '{"plano": "ouro", "dependentes": [1, 2]}'), ('Bia', 'bia@exemplo.com', NULL);
  `);
  await conn.end();
  process.env.CAIS_TEST_MYSQL = JSON.stringify({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  });
  return () => db.stop();
}
