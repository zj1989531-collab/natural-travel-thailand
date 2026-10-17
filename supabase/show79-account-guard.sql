-- Bind the authenticated payer account to the account that opened the form.
-- Keep the original nine-argument RPC available for older installed clients.
create or replace function public.record_show79_settlement(
  p_operation_id uuid,
  p_month text,
  p_payment_date date,
  p_jimmy_paid_thb numeric,
  p_partners_paid_thb numeric,
  p_note text,
  p_expected_profit_thb numeric,
  p_expected_jimmy_paid_thb numeric,
  p_expected_partners_paid_thb numeric,
  p_expected_user_id uuid
)
returns public.show79_settlements
language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then
    raise exception '账号已切换，请重新打开当前账本再登记分账。' using errcode = '42501';
  end if;
  return public.record_show79_settlement(
    p_operation_id, p_month, p_payment_date, p_jimmy_paid_thb, p_partners_paid_thb,
    p_note, p_expected_profit_thb, p_expected_jimmy_paid_thb, p_expected_partners_paid_thb
  );
end;
$$;
revoke execute on function public.record_show79_settlement(uuid,text,date,numeric,numeric,text,numeric,numeric,numeric,uuid)
  from public, anon, authenticated;
grant execute on function public.record_show79_settlement(uuid,text,date,numeric,numeric,text,numeric,numeric,numeric,uuid)
  to authenticated;
notify pgrst, 'reload schema';
