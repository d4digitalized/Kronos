-- 0049: přílohy v úložišti jen pro ty, kdo vidí kartu (audit §5.3).
--
-- Dřív storage politika kontrolovala jen první složku cesty (firmu): každý
-- člen firmy si přes Storage API vypsal a stáhl i přílohy karet, které
-- nevidí, a nahrát mohl do složky kterékoli karty firmy.
--
-- Teď (cesta objektu je {workspace_id}/{task_id}/{uuid}-{název}):
--  * číst smí ten, kdo vidí záznam přílohy (task_attachments → RLS karty),
--    k tomu nahrávající a admin firmy — ti dva i po smazání záznamu
--    (aplikace maže nejdřív záznam, pak soubor; mazání čte objekt přes SELECT),
--  * nahrávat jen ke kartě, kterou vidím, a jen do složky její firmy,
--  * mazání beze změny (nahrávající nebo admin firmy).
--
-- NEJDŘÍV pustit supabase/tests/0049_kontrola.sql — ukáže, komu kolik
-- příloh přestane být vidět, a ověří, že nikdo nic nezíská navíc.
-- Úsek mezi značkami >>> / <<< má test doslova zkopírovaný.

begin;

-- >>> 0049:ddl
-- čtecí politika hledá záznam přílohy podle cesty
create index if not exists task_attachments_object_path_idx
  on public.task_attachments (object_path);

drop policy if exists task_attachments_obj_select on storage.objects;
create policy task_attachments_obj_select on storage.objects for select
  to authenticated
  using (
    bucket_id = 'task-attachments'
    and (
      owner = (select auth.uid())
      or (select public.is_super_admin())
      or (storage.foldername(name))[1] = any ((select public.my_admin_ws_ids())::text[])
      or exists (select 1 from public.task_attachments a
                  where a.object_path = storage.objects.name)
    )
  );

-- case: přetypování na uuid až po kontrole tvaru (pořadí v AND není zaručené)
drop policy if exists task_attachments_obj_insert on storage.objects;
create policy task_attachments_obj_insert on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'task-attachments'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
       and (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
      then exists (select 1 from public.tasks t
                    where t.id = ((storage.foldername(name))[2])::uuid
                      and t.workspace_id = ((storage.foldername(name))[1])::uuid)
      else false
    end
  );
-- <<< 0049:ddl

commit;
