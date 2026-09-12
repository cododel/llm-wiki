import {randomUUID} from 'node:crypto';
import {connect,migrate} from '../src/storage/database.ts';

/** Only a verifier-created parent database can provision a test database. */
export async function disposable(label:string,initialize=true) {
  const url=process.env.TEST_DATABASE_URL;
  if(!url||!/^\/wiki_test_[a-z0-9_]+$/.test(new URL(url).pathname))throw new Error('Disposable TEST_DATABASE_URL required');
  if(!/^[a-z]+$/.test(label))throw new Error('Invalid test label');
  const admin=connect(url),name=`wiki_test_${label}_${randomUUID().replaceAll('-','')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`).simple();
  const destination=new URL(url);destination.pathname=`/${name}`;
  const db=connect(destination.href);
  const close=async()=>{try{await db.close();await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`).simple();}finally{await admin.close();}};
  try {if(initialize)await migrate(db);}catch(error){await close();throw error;}
  return {db,url:destination.href,close};
}
