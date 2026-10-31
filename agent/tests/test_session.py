from glovebox_agent.session import amount_key

from .conftest import make_state


def test_refs_are_short_and_per_kind():
    s = make_state()
    assert s.add_record("expense", "a", "pending", "Toll, 12 dollars.").ref == "E1"
    assert s.add_record("ticket", "b", "pending", "Scale ticket.").ref == "T1"
    assert s.add_record("expense", "c", "pending", "Fuel.").ref == "E2"
    # Refreshing a known record keeps its ref.
    assert s.add_record("expense", "a", "confirmed", "Toll, 12 dollars.").ref == "E1"
    assert s.record("e1") is s.records["E1"]
    assert s.records["E1"].status == "confirmed"


def test_pending_duplicate_matches_category_and_amount():
    s = make_state()
    s.add_record("expense", "a", "pending", "Fuel.", category="fuel", amount="512.40")
    assert s.pending_duplicate("fuel", "$512.4").ref == "E1"
    assert s.pending_duplicate("fuel", "512.41") is None
    assert s.pending_duplicate("toll", "512.40") is None
    s.records["E1"].status = "confirmed"
    assert s.pending_duplicate("fuel", "512.40") is None


def test_amount_key_only_normalizes_for_comparison():
    assert amount_key("$1,250") == amount_key("1250.00")
    assert amount_key("a couple hundred") is None


def test_idempotency_key_uses_the_tool_call_id_or_a_fresh_uuid():
    s = make_state()
    assert s.idempotency_key("log_expense", "fc_abc") == "call_test:fc_abc:log_expense"
    a = s.idempotency_key("log_expense", None)
    b = s.idempotency_key("log_expense", None)
    assert a != b and a.startswith("call_test:") and a.endswith(":log_expense")


def test_find_stop_by_type_alias_or_name():
    s = make_state()
    load = s.loads["7712"]
    assert s.find_stop(load, "delivery").facility_name.startswith("Millbrook")
    assert s.find_stop(load, "receiver").type == "delivery"
    assert s.find_stop(load, "shipper").type == "pickup"
    assert s.find_stop(load, "sutter").type == "pickup"
    assert s.find_stop(load, "nowhere") is None


def test_filler_at_most_once_per_turn():
    s = make_state()
    assert s.take_filler() is True
    assert s.take_filler() is False
    s.next_turn()
    assert s.take_filler() is True
