const express = require("express");

const router = express.Router();

const {
  postTicket,
  getTickets,
  patchTicket,
  assumirTicket,
  transferirTicket,
  getTicketDashboard
} = require("../controllers/ticket.controller");

router.get("/tickets/dashboard", getTicketDashboard);
router.get("/tickets", getTickets);
router.post("/tickets", postTicket);
router.patch("/tickets/:id", patchTicket);
router.patch("/tickets/:id/assign", assumirTicket);
router.patch("/tickets/:id/transfer", transferirTicket);

module.exports = router;